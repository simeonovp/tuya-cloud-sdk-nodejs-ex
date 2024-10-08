const TuyaCloudSDKException = require("../exception/tuya_cloud_sdk_exception");
const ApiRequestBody = require("./api_request_body");
const ApiRequest = require("./api_request");
const ApiFileRequest = require("./api_file_request");
const HttpConnection = require("./http_connection");
const ErrorCode = require("./error_code");
const TokenCache = require("./token_cache");
const Sign = require("./sign");
const HttpMethod = require("./http_method");

const retry = require('async-await-retry');


/**
 * 请求处理类
 */
class RequestHandler {

    /**
     * 执行请求, 不携带token
     *
     * @param request
     * @param callback
     * @returns {Promise<*|*>}
     */
    static async sendRequest(request, callback) {
        return this.execute(request, false, callback);
    }

    /**
     * 执行请求, 需携带token
     *
     * @param request
     * @param callback
     * @returns {Promise<*>}
     */
    static async sendRequestWithToken(request, callback) {
        return await retry(async () => {
            return new Promise(async (resolve, reject) => {
                await this.execute(request, true, async function (err, data) {
                    if (err) {
                        if (err.code == 1100) {
                            global.accessToken = undefined;
                            reject(err);
                        }
                        callback(err, null);
                        return;
                    }

                    callback(null, data);
                    resolve('OK');
                });
            })
        });
    }

    /**
     * 执行请求
     *
     * @param request
     * @param withToken
     * @param callback
     */
    static async execute(request, withToken, callback) {
        // 验证开发者信息
        if (global.accessId == undefined || global.accessKey == undefined) {
            return await callback(new TuyaCloudSDKException("100000", "未初始化开发者信息！"), null);
        }

        // 验证请求参数
        let method, url, stream;
        if (request instanceof ApiRequest) {
            method = request.getRequestMethod();
            if (!(method instanceof HttpMethod)) {
                return await callback(new TuyaCloudSDKException("100000", "Method only support GET, POST, PUT, DELETE"), null);
            }
            method = method.getName();
            url = request.getRequestUrl();

            let query = request.getRequestQuery && request.getRequestQuery()
            if (query) {
                // note: signature must be calculated before URL-encoding!
                if (typeof query === 'string') {
                  // if it's a string then assume no url-encoding is needed
                  url += query.startsWith('?') && query || ('?' + query)
                }
                else {
                  // object keys are unsorted, however Tuya requires the keys to be in alphabetical order for signing
                  // as per https://developer.tuya.com/en/docs/iot/singnature?id=Ka43a5mtx1gsc
                  if (typeof query === 'object') {
                    const sortObject = (obj) => {
                      return Object.keys(obj).sort().reduce((result, key) => {
                        result[key] = obj[key]
                        return result
                      }, {})
                    }
                    query = sortObject(query)
                    // calculate signature without url-encoding
                    const entries = []
                    Object.entries(query).forEach(([key, val]) => entries.push(`${key}=${val}`))
                    url += '?' + entries.join('&')
                  }
                }
            }
        }
        else if (request instanceof ApiFileRequest) {
            method = 'GET'
            url = request.getRequestUrl()
            stream = request.getOutStream()
        }

        if (method == undefined || url == undefined) {
            return await callback(new TuyaCloudSDKException("100000", "请求参数错误，请核对"));
        }

        let req = {
            method: method,
            host: global.endpoint,
            path: url
        };

        // body param
        if (request instanceof ApiRequestBody) {
            req.form = JSON.parse(request.getRequestBody());
        }

        // headers
        const opt = (request instanceof ApiRequestBody) && request.getRequestOpt && request.getRequestOpt() || {}
        await this.getHeader(withToken, opt, req).then(data => {
            req.headers = JSON.parse(data);
        });

        if (method === HttpMethod.POST.getName()) {
            req.headers['Content-Type'] = 'application/json';
        }

        return new Promise((resolve, reject) => {
            if (request instanceof ApiRequest) {
                HttpConnection.doRequest(req, async(error, data) => {
                    if (error) {
                        const tcError = new TuyaCloudSDKException(error.message);
                        await callback(tcError, null);
                    } else {
                        try {
                            data = JSON.parse(data);
                        } catch (err) {
                            const tcError = new TuyaCloudSDKException(err)
                            await callback(tcError, null)
                            reject(err)
                        }
                        if (!data.success) {
                            const tcError = new TuyaCloudSDKException(data.code, ErrorCode.getError(data.code));
                            await callback(tcError, null);
                        } else {
                            await callback(null, data);
                            resolve(data);
                        }
                    }
                }, {timeout: 30000});
            }
            else  if (request instanceof ApiFileRequest) {
                //https://support.tuya.com/en/help/_detail/K9g77ztjza6uj
                req.host = req.host.replace('openapi.', 'images.')
                HttpConnection.doFileRequest(req, stream, async(error, data) => {
                    if (error) {
                        const tcError = new TuyaCloudSDKException(error.message);
                        await callback(tcError, null);
                    } else {
                      await callback(null, data)
                    }
            }, {timeout: 30000})
        }
    });
    }

    /**
     * 获取header
     *
     * @param withToken 是否携带token
     * @param opt 自定义header
     * @returns {{t: *, sign_method: *, sign: *, client_id: *}}
     */
     static async getHeader(withToken, opt, req) {
        let headers = {
            client_id: global.accessId,
            t: new Date().getTime(),
            sign_method: "HMAC-SHA256",
        };

        if (withToken) {
            headers.access_token = await TokenCache.getToken();
            headers.sign = this.calcSign(global.accessId, global.accessKey, headers.t, headers.access_token, true, req, headers);
        } else {
            headers.sign = this.calcSign(global.accessId, global.accessKey, headers.t, null, false, req, headers);
        }

        Object.assign(headers, opt);
        return new Promise((resolve, reject) => {
            resolve(JSON.stringify(headers));
        });
    }

    /**
     * 计算sign
     *
     * @param accessId
     * @param secret
     * @param t
     * @param accessToken
     * @param withToken
     * @returns {string}
     */
    static calcSign(accessId, secret, t, accessToken, withToken, req, headers) {
        let message = accessId + t;
        if (withToken) {
            message = accessId + accessToken + t;
        }

        // update the payload to include it's data if running the new signing algorithm (post 30.6.2021)
        if (global.new_sign_algorithm) {
            if (!req || ! headers) console.error('new_sign_algorithm needs parameter req and header to be set to calculate signature')
            else {
                const signValues = []
                const signHeaders = headers['Signature-Headers'] || ''
                signHeaders.split(':').forEach(key => key && signValues.push(key))
                message += `${req.method}\n` + //HTTPMethod
                    `${Sign.hashSHA256(req.form || '')}\n` + // Content-SHA256
                    `${signValues.join('')}\n` + // Headers
                    `${req.path || ''}`
            }
        }
        return Sign.encrytSHA256(message, secret);
    }

}

module.exports = RequestHandler;