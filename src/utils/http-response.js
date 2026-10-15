/** Sends the standard success envelope: `{ data, meta? }`. */
export function sendData(res, status, data, meta) {
  const body = meta === undefined ? { data } : { data, meta };
  res.status(status).json(body);
}
