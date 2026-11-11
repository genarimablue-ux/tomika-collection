// The official product details live in one editable JSON file. This module keeps
// the collection UI's synchronous catalog interface while loading that data.
const catalogUrl = new URL("./tomica-catalog.json", import.meta.url);
const response = await fetch(catalogUrl, { cache: "no-cache" });
if (!response.ok) throw new Error(`Official Tomica catalog could not be loaded (${response.status})`);

const source = await response.json();
const products = Array.isArray(source.products) ? source.products : [];
export const MAX_NUMBER = Number(source.total) || 0;
export const CATALOG = products
  .map((product) => ({
    number: Number(product.number),
    name: String(product.name || "").trim(),
    imageUrl: String(product.imageUrl || "").trim(),
  }))
  .sort((a, b) => a.number - b.number);

if (
  MAX_NUMBER < 1
  || CATALOG.length !== MAX_NUMBER
  || CATALOG.some((item, index) => item.number !== index + 1 || !item.name || !item.imageUrl)
) {
  throw new Error("Official Tomica catalog is incomplete or invalid");
}
