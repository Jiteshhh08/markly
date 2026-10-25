import http from "node:http";
import jwt from "jsonwebtoken";
import { signToken } from "../../src/lib/auth.js";

// STAGE 2 test helpers. These only wire a real Express app to a real ephemeral
// HTTP port and build signed cookies/Bearer headers for persisted test users.
// No production data, no mocks of the persistence layer.

export async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function stopServer(server) {
  if (!server) return;
  try {
    server.closeAllConnections?.();
  } catch {
    /* older node */
  }
  await new Promise((resolve) => server.close(resolve));
}

export function cookieFor(user) {
  return `markly_token=${signToken(user)}`;
}

export function bearerFor(user) {
  return `Bearer ${signToken(user)}`;
}

// STAGE 3: a token carrying attacker-supplied extra claims (for example a
// forged platform_admin role). Authorization must ignore these claims and read
// the persisted user instead.
export function forgedCookieFor(user, extra = {}) {
  const token = jwt.sign(
    { sub: user.id, email: user.email, ...extra },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
  return `markly_token=${token}`;
}

function isMultipartBody(body) {
  return (
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
  );
}

export async function request(
  base,
  method,
  path,
  { body, cookie, auth, headers = {}, timeoutMs = 20000 } = {},
) {
  const outgoing = { ...headers };
  if (cookie) outgoing.cookie = cookie;
  if (auth) outgoing.authorization = auth;

  let payload;
  if (body !== undefined) {
    if (isMultipartBody(body) || Buffer.isBuffer(body) || typeof body === "string") {
      // Fetch computes the multipart boundary itself. Manually setting a
      // content-type here would corrupt the upload.
      payload = body;
    } else {
      outgoing["content-type"] ??= "application/json";
      payload = JSON.stringify(body);
    }
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers: outgoing,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString("utf8");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    data,
    text,
    buffer,
    contentType: res.headers.get("content-type") ?? "",
    setCookies,
  };
}
