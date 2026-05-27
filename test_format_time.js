// Test the formatTime function with the actual database value
const dbTime = "1970-01-01T17:00:00.000Z";
const dt = new Date(dbTime);

console.log('=== DATE PARSING TEST ===');
console.log('Input:', dbTime);
console.log('Parsed Date:', dt);
console.log('getUTCHours():', dt.getUTCHours());
console.log('getHours():', dt.getHours());
console.log('getTime():', dt.getTime());
console.log('toISOString():', dt.toISOString());

// Simulate formatTime function
const pad2 = (n) => String(n).padStart(2, '0');
let hh = dt.getUTCHours();
const mm = pad2(dt.getUTCMinutes());
const ampm = hh >= 12 ? 'PM' : 'AM';
hh = hh % 12;
if (hh === 0) hh = 12;
const formatted = `${pad2(hh)}:${mm} ${ampm}`;

console.log('\n=== FORMATTED OUTPUT ===');
console.log('UTC-based format:', formatted);

// Test with local hours
let hhLocal = dt.getHours();
const mmLocal = pad2(dt.getMinutes());
const ampmLocal = hhLocal >= 12 ? 'PM' : 'AM';
hhLocal = hhLocal % 12;
if (hhLocal === 0) hhLocal = 12;
const formattedLocal = `${pad2(hhLocal)}:${mmLocal} ${ampmLocal}`;

console.log('Local-based format:', formattedLocal);
