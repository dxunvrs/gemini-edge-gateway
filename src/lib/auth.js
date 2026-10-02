export function authenticate(request, authorizedUsers) {
  const url = new URL(request.url);
  const authHeader = (request.headers.get("Authorization") || "").trim();
  const queryAuth = url.searchParams.get("auth");

  let token = "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (authHeader) {
    token = authHeader;
  } else if (queryAuth) {
    token = queryAuth.trim();
  }

  const matched = authorizedUsers.find((u) => u.secret === token);
  if (matched) {
    return { ok: true, user: matched.user };
  }

  return { ok: false, user: null };
}
