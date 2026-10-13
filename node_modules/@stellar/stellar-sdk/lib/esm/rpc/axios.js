import { create as createFetchClient } from '../http-client/fetch-client.js';

const version = "17.2.1";
function createHttpClient(headers) {
  return createFetchClient({
    headers: {
      ...headers,
      "X-Client-Name": "js-stellar-sdk",
      "X-Client-Version": version
    }
  });
}

export { createHttpClient, version };
//# sourceMappingURL=axios.js.map
