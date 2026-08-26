// Throwaway diagnostic — NOT part of the provisioning tool. Run on the host,
// type "TESTCLAN" then press Enter, and paste the full output back.
const stdin = process.stdin;
process.stdout.write(`isTTY: ${stdin.isTTY}, initial isRaw: ${stdin.isRaw}\n`);
process.stdout.write('Type TESTCLAN then press Enter: ');

let input = '';
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding('utf8');

stdin.on('data', (buf) => {
  process.stdout.write(`\n[RAW EVENT] length=${buf.length} bytes=[${[...buf].map(c => c.charCodeAt(0)).join(',')}] text=${JSON.stringify(buf)}\n`);
  for (const ch of buf) {
    if (ch === '\r' || ch === '\n') {
      stdin.setRawMode(false);
      process.stdout.write(`\nFINAL input=${JSON.stringify(input)} length=${input.length}\n`);
      process.exit(0);
    }
    input += ch;
  }
});
