export function getQuery(query: { [k: string]: unknown }, noUndefined = true) {
  return new URLSearchParams(
    Object.fromEntries(
      Object.entries(query)
        .filter(([, v]) => v !== undefined || !noUndefined)
        .map(([key, value]) => [key, String(value)])
    )
  );
}

export function nanoid(length = 8) {
  const chars =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
  let id = '';
  for (let i = length; i > 0; --i)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}