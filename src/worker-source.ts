// Worker code exported as a string constant for Blob URL loading.
// Must be self-contained: no imports, no TypeScript, no ES2020+ features.
export const WORKER_SOURCE = `
  function createRingBuffer(capacity) {
    var buffer = new Array(capacity);
    var head = 0;
    var count = 0;

    return {
      push: function(item) {
        buffer[head] = item;
        head = (head + 1) % capacity;
        if (count < capacity) count++;
      },
      toArray: function() {
        if (count === 0) return [];
        var start = (head - count + capacity) % capacity;
        if (start < head) {
          return buffer.slice(start, head);
        }
        return buffer.slice(start, capacity).concat(buffer.slice(0, head));
      },
      clear: function() {
        buffer = new Array(capacity);
        head = 0;
        count = 0;
      },
      resize: function(newCap) {
        var items = this.toArray();
        capacity = newCap;
        buffer = new Array(newCap);
        head = 0;
        count = 0;
        var start = items.length > newCap ? items.length - newCap : 0;
        for (var i = start; i < items.length; i++) {
          this.push(items[i]);
        }
      },
      getCount: function() { return count; }
    };
  }

  var maxEntries = 2000;
  var entries = createRingBuffer(maxEntries);
  var networkEntries = createRingBuffer(maxEntries);
  var userEventEntries = createRingBuffer(maxEntries);

  self.onmessage = function(e) {
    var msg = e.data;

    if (msg.type === 'CONFIG') {
      maxEntries = msg.maxEntries;
      entries.resize(maxEntries);
      networkEntries.resize(maxEntries);
      userEventEntries.resize(maxEntries);
      return;
    }

    if (msg.type === 'ENTRY') {
      entries.push(msg.data);
      return;
    }

    if (msg.type === 'NETWORK_ENTRY') {
      networkEntries.push(msg.data);
      return;
    }

    if (msg.type === 'USER_EVENT') {
      userEventEntries.push(msg.data);
      return;
    }

    if (msg.type === 'CLEAR') {
      entries.clear();
      networkEntries.clear();
      userEventEntries.clear();
      self.postMessage({ type: 'CLEARED' });
      return;
    }
  };
`;
