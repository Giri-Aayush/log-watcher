// Fixed-size ring of the most recent items. Array shift() is O(n) but n is
// the ring size (a few thousand lines), which is nothing next to the I/O
// that feeds it. Simpler than a circular index and impossible to get wrong.
class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.size) this.items.shift();
    return item;
  }

  last(n = this.size) {
    return n <= 0 ? [] : this.items.slice(-n);
  }

  get length() {
    return this.items.length;
  }
}

module.exports = { Ring };
