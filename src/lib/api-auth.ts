export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Проверяет `Authorization: Bearer <API_TOKEN>`. Без заданного API_TOKEN API закрыто полностью. */
export function checkApiToken(request: Request): boolean {
  const token = process.env.API_TOKEN;
  if (!token || token.length < 16) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return !!match && safeEqual(match[1].trim(), token);
}
