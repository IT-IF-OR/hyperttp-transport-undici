export function abortError(reason) {
    if (reason instanceof Error)
        return reason;
    if (typeof reason === "string" && reason.length > 0)
        return new Error(reason);
    return new DOMException("The operation was aborted.", "AbortError");
}
export function createPoolOptions(config) {
    const net = config.network;
    return {
        connections: net?.maxConcurrent ?? 500,
        pipelining: net?.pipelining ?? 8,
        keepAliveTimeout: net?.keepAliveTimeout ?? 30000,
        allowH2: config.stealth?.http2 ?? true,
    };
}
export function fastParseUrl(url, defaultBase) {
    const len = url.length;
    if (len === 0)
        return fallbackParse(url, defaultBase);
    const firstChar = url.charCodeAt(0);
    if (firstChar === 47) {
        // '/'
        if (len > 1 && url.charCodeAt(1) === 47) {
            // '//'
            return fallbackParse("https:" + url, defaultBase);
        }
        const hashIdx = url.indexOf("#");
        const cleanPath = hashIdx === -1 ? url : url.slice(0, hashIdx);
        return {
            origin: defaultBase,
            path: cleanPath,
            fullUrl: defaultBase + cleanPath,
        };
    }
    const schemeIdx = url.indexOf("://");
    if (schemeIdx !== -1) {
        const start = schemeIdx + 3;
        let pathIdx = -1;
        let qIdx = -1;
        let hashIdx = -1;
        for (let i = start; i < len; i++) {
            const code = url.charCodeAt(i);
            if (code === 64)
                return fallbackParse(url, defaultBase); // '@' userinfo
            if (code === 47) {
                pathIdx = i;
                break;
            }
            if (code === 63) {
                qIdx = i;
                break;
            }
            if (code === 35) {
                hashIdx = i;
                break;
            }
        }
        if (pathIdx !== -1) {
            hashIdx = url.indexOf("#", pathIdx);
            const origin = url.slice(0, pathIdx);
            const cleanPath = hashIdx === -1 ? url.slice(pathIdx) : url.slice(pathIdx, hashIdx);
            return { origin, path: cleanPath, fullUrl: origin + cleanPath };
        }
        if (qIdx !== -1) {
            hashIdx = url.indexOf("#", qIdx);
            const origin = url.slice(0, qIdx);
            const cleanPath = hashIdx === -1 ? "/" + url.slice(qIdx) : "/" + url.slice(qIdx, hashIdx);
            return { origin, path: cleanPath, fullUrl: origin + cleanPath };
        }
        if (hashIdx !== -1) {
            const origin = url.slice(0, hashIdx);
            return { origin, path: "/", fullUrl: origin + "/" };
        }
        return { origin: url, path: "/", fullUrl: url + "/" };
    }
    return fallbackParse(url, defaultBase);
}
function fallbackParse(url, defaultBase) {
    try {
        const parsed = new URL(url, defaultBase);
        const cleanPath = parsed.pathname + parsed.search;
        return {
            origin: parsed.origin,
            path: cleanPath,
            fullUrl: parsed.origin + cleanPath,
        };
    }
    catch {
        return { origin: defaultBase, path: url, fullUrl: defaultBase + url };
    }
}
export function fastNormalizeResponseHeaders(headers) {
    const out = {};
    for (const key in headers) {
        out[key.toLowerCase()] = headers[key];
    }
    return out;
}
export function normalizeHeaders(headers) {
    if (!headers)
        return {};
    if (headers instanceof Headers) {
        const out = {};
        headers.forEach((value, key) => {
            out[key.toLowerCase()] = value;
        });
        return out;
    }
    if (Array.isArray(headers)) {
        const out = {};
        for (let i = 0; i < headers.length; i += 2) {
            const key = headers[i];
            const value = headers[i + 1];
            if (typeof key !== "string" || !key || value == null)
                continue;
            out[key.toLowerCase()] = String(value);
        }
        return out;
    }
    const src = headers;
    let needsNormalize = false;
    for (const key in src) {
        if (key !== key.toLowerCase()) {
            needsNormalize = true;
            break;
        }
        const v = src[key];
        if (v == null || Array.isArray(v)) {
            needsNormalize = true;
            break;
        }
    }
    if (!needsNormalize)
        return src;
    const out = {};
    for (const key in src) {
        const value = src[key];
        if (value == null)
            continue;
        const lowerKey = key.toLowerCase();
        if (Array.isArray(value)) {
            if (lowerKey === "set-cookie") {
                out[lowerKey] = value.join("\n");
            }
            else if (lowerKey === "cookie") {
                out[lowerKey] = value.join("; ");
            }
            else {
                out[lowerKey] = value.join(", ");
            }
            continue;
        }
        out[lowerKey] = String(value);
    }
    return out;
}
//# sourceMappingURL=helpers.js.map