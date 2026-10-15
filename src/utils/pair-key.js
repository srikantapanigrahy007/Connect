/**
 * The same key for a pair of users whichever order they come in: "smallerId:largerId".
 * Used to make "one pending request per pair" and "one connection per pair" unique indexes.
 *
 * @param {unknown} a
 * @param {unknown} b
 */
export function pairKey(a, b) {
  const [first, second] = [String(a), String(b)].sort();
  return `${first}:${second}`;
}
