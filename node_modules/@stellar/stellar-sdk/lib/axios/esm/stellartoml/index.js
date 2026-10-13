import { parse } from 'smol-toml';
import { axiosClient } from '../http-client/axios-client.js';
import { Config } from '../config.js';

const STELLAR_TOML_MAX_SIZE = 100 * 1024;
const STELLAR_TOML_PATH = "/.well-known/stellar.toml";
const INVALID_DOMAIN_CHARS = /[\s@/?#\\]/;
const TRAILING_SEPARATORS = /[/\\]+$/;
class Resolver {
  /**
   * Returns a parsed `stellar.toml` file for a given domain.
   * @see {@link https://developers.stellar.org/docs/tokens/publishing-asset-info | Stellar.toml doc}
   *
   * @param domain - Domain to get stellar.toml file for. Must be a host name with an optional port; surrounding whitespace and a trailing `/` are ignored.
   * @param opts - (optional) Options object
   *   - `allowHttp` (optional): Allow connecting to http servers. This must be set to false in production deployments!
   *   - `timeout` (optional): Allow a timeout. Allows user to avoid nasty lag due to TOML resolve issue.
   * @returns A `Promise` that resolves to the parsed stellar.toml object
   * @throws `Error` if `domain` is not a plain host name, before any request is made
   *
   * @example
   * ```ts
   * StellarSdk.StellarToml.Resolver.resolve('acme.com')
   *   .then(stellarToml => {
   *     // stellarToml in an object representing domain stellar.toml file.
   *   })
   *   .catch(error => {
   *     // domain is invalid, or stellar.toml does not exist or is invalid
   *   });
   * ```
   */
  static async resolve(domain, opts = {}) {
    const { CancelToken } = axiosClient;
    const allowHttp = typeof opts.allowHttp === "undefined" ? Config.isAllowHttp() : opts.allowHttp;
    const timeout = typeof opts.timeout === "undefined" ? Config.getTimeout() : opts.timeout;
    const protocol = allowHttp ? "http" : "https";
    const name = String(domain).trim().replace(TRAILING_SEPARATORS, "");
    let url;
    try {
      url = new URL(`${protocol}://${name}${STELLAR_TOML_PATH}`);
    } catch {
    }
    if (!url || INVALID_DOMAIN_CHARS.test(name) || url.host.includes("%") || url.href !== `${protocol}://${url.host}${STELLAR_TOML_PATH}`) {
      throw new Error(
        `Invalid domain: ${JSON.stringify(domain)}. A domain must be a host name with an optional port.`
      );
    }
    return axiosClient.get(url.href, {
      maxRedirects: opts.allowedRedirects ?? 0,
      maxContentLength: STELLAR_TOML_MAX_SIZE,
      cancelToken: timeout ? new CancelToken(
        (cancel) => setTimeout(
          () => cancel(`timeout of ${timeout}ms exceeded`),
          timeout
        )
      ) : void 0,
      timeout
    }).then((response) => {
      try {
        const tomlObject = parse(response.data);
        return Promise.resolve(tomlObject);
      } catch (e) {
        return Promise.reject(
          new Error(
            `stellar.toml is invalid - Parsing error on line ${e.line}, column ${e.column}: ${e.message}`
          )
        );
      }
    }).catch((err) => {
      if (err.message.match(/^maxContentLength size/)) {
        throw new Error(
          `stellar.toml file exceeds allowed size of ${STELLAR_TOML_MAX_SIZE}`
        );
      } else {
        throw err;
      }
    });
  }
}

export { Resolver, STELLAR_TOML_MAX_SIZE };
//# sourceMappingURL=index.js.map
