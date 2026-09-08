// A bounded map that forgets its least recently used entry once it is full. The holder gate's cache, the refused
// origins and the request budget each kept a plain Map keyed on whatever a stranger sent (a wallet address in a
// query, an Origin header, a forwarded address), so a loop that varied the key grew the process without bound
// (2026-09-08). A Map iterates in insertion order, so moving a key to the end on every touch makes the first
// key the oldest, and eviction is one delete at the front: no timestamps, no scan.
export class Lru<K, V> {
  private map = new Map<K, V>();
  /** Entries kept at most; never fewer than one. */
  readonly max: number;
  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max) || 1);
  }
  get size(): number {
    return this.map.size;
  }
  /** The value, and the key is now the most recently used. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  /** The value without touching its place in the order. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  /** The key becomes the most recently used; past `max` the least recently used is forgotten. */
  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return this;
  }
  delete(key: K): boolean {
    return this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  /** Least recently used first. Deleting while iterating is safe, as with a Map. */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }
  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
