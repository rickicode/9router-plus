export function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function parseUrl(value) {
  if (!value) return null;

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function getRequestUrlCandidates(request) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (value) => {
    const parsed = parseUrl(value);
    if (!parsed) return;

    const key = parsed.origin;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(parsed);
  };

  addCandidate(request.url);

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    addCandidate(`${forwardedProto}://${forwardedHost}`);
  }

  const host = request.headers.get("host");
  if (host) {
    addCandidate(`http://${host}`);
    addCandidate(`https://${host}`);
  }

  return candidates;
}

function isLoopbackRequest(request) {
  return getRequestUrlCandidates(request).some((requestUrl) => isLoopbackHostname(requestUrl.hostname));
}

function isAllowedSameOrigin(request, candidate) {
  if (!candidate) return false;

  const candidateUrl = parseUrl(candidate);
  if (!candidateUrl) return false;

  return getRequestUrlCandidates(request).some((requestUrl) => {
    if (candidateUrl.origin === requestUrl.origin) return true;

    return (
      isLoopbackHostname(candidateUrl.hostname) &&
      isLoopbackHostname(requestUrl.hostname) &&
      candidateUrl.port === requestUrl.port &&
      candidateUrl.protocol === requestUrl.protocol
    );
  });
}

function hasTrustedFetchSite(secFetchSite) {
  return secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none";
}

function isLoopbackCandidate(candidate) {
  const parsed = parseUrl(candidate);
  return parsed ? isLoopbackHostname(parsed.hostname) : false;
}

export function hasValidCloudRouteOrigin(request) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const secFetchSite = request.headers.get("sec-fetch-site");
  const requestedWith = request.headers.get("x-requested-with");
  const trustedFetchSite = hasTrustedFetchSite(secFetchSite);
  const ajaxRequest = requestedWith === "XMLHttpRequest";
  const isDevLoopback = process.env.NODE_ENV !== "production" && isLoopbackRequest(request);

  if (origin) {
    if (isAllowedSameOrigin(request, origin)) return true;
    if (isDevLoopback && trustedFetchSite && isLoopbackCandidate(origin)) return true;
    return false;
  }

  if (referer) {
    if (isAllowedSameOrigin(request, referer)) return true;
    if (isDevLoopback && trustedFetchSite && isLoopbackCandidate(referer)) return true;
    return false;
  }

  if (trustedFetchSite || ajaxRequest) return true;

  // Some localhost browser requests strip origin metadata entirely or pass
  // through an internal URL that does not match the browser-visible origin.
  if (isDevLoopback) {
    return true;
  }

  return false;
}
