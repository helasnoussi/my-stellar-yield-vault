'use strict';

function encodeSegment(segment) {
  const value = typeof segment === "number" || typeof segment === "bigint" ? String(segment) : segment;
  if (typeof value !== "string") {
    throw new TypeError(
      `expected a string, number or bigint path segment, not ${typeof value}`
    );
  }
  if (value === "" || value === "." || value === "..") {
    throw new TypeError(
      `expected a single non-empty path segment, not ${JSON.stringify(value)}`
    );
  }
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError(
      `expected a well-formed path segment, not ${JSON.stringify(value)}`
    );
  }
}
function stringifyTemplateValue(value) {
  return Array.isArray(value) ? value.join(",") : value.toString();
}
function expandPlaceholders(template, variables, encode) {
  return template.replace(/\{([^?][^}]*)\}/g, (_match, name) => {
    const value = variables[name];
    return typeof value === "undefined" ? "" : encode(value);
  });
}
function expandUriTemplate(template, variables, baseUrl) {
  const queryNames = [];
  const withoutQueryTemplate = template.replace(
    /\{\?([^}]+)\}/g,
    (_match, names) => {
      queryNames.push(...names.split(","));
      return "";
    }
  );
  const queryStart = withoutQueryTemplate.indexOf("?");
  const pathTemplate = queryStart === -1 ? withoutQueryTemplate : withoutQueryTemplate.slice(0, queryStart);
  const queryTemplate = queryStart === -1 ? "" : withoutQueryTemplate.slice(queryStart);
  const expanded = expandPlaceholders(pathTemplate, variables, encodeSegment) + expandPlaceholders(
    queryTemplate,
    variables,
    (value) => encodeURIComponent(stringifyTemplateValue(value))
  );
  const url = new URL(expanded, baseUrl);
  queryNames.forEach((name) => {
    const value = variables[name];
    if (typeof value !== "undefined") {
      url.searchParams.set(name, stringifyTemplateValue(value));
    }
  });
  return url.toString();
}

exports.encodeSegment = encodeSegment;
exports.expandUriTemplate = expandUriTemplate;
//# sourceMappingURL=url.js.map
