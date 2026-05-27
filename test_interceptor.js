// Test if the interceptor fix is working
const serializeBigInts = (value) => {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "bigint") return value.toString();
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const isTimeField = value.getUTCFullYear() === 1970 && 
                        value.getUTCMonth() === 0 && 
                        value.getUTCDate() === 1;
    if (isTimeField) {
      const hh = String(value.getUTCHours()).padStart(2, '0');
      const mm = String(value.getUTCMinutes()).padStart(2, '0');
      const ss = String(value.getUTCSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
    return value.toISOString();
  }
  if (t === "object" && value?.constructor?.name === "Decimal") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeBigInts);
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    const isPlain = proto === Object.prototype || proto === null;
    if (!isPlain) return value;
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = serializeBigInts(value[k]);
    }
    return out;
  }
  return value;
};

// Test with the actual database value
const dbTime = new Date("1970-01-01T17:00:00.000Z");
console.log('=== INTERCEPTOR TEST ===');
console.log('Input:', dbTime);
console.log('Serialized:', serializeBigInts(dbTime));

// Test with a full object
const testObj = {
  hotspot_start_time: dbTime,
  hotspot_end_time: new Date("1970-01-01T18:00:00.000Z"),
  name: "Test"
};
console.log('\n=== FULL OBJECT TEST ===');
console.log('Input:', JSON.stringify(testObj, null, 2));
console.log('Serialized:', JSON.stringify(serializeBigInts(testObj), null, 2));
