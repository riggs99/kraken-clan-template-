// Throwaway diagnostic — NOT part of the provisioning tool. Reproduces the
// exact retry-loop pattern askValidated() uses: read a line, reject it once
// on purpose, read again. Type TESTCLAN both times, press Enter each time.
function readLine() {
  return new Promise(resolve => {
    let input = '';
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }

    const onData = (buf) => {
      process.stdout.write(`\n  [RAW EVENT] length=${buf.length} bytes=[${[...buf].map(c => c.charCodeAt(0)).join(',')}] text=${JSON.stringify(buf)}`);
      for (const ch of buf) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        input += ch;
        process.stdout.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(promptText) {
  process.stdout.write(promptText);
  const value = await readLine();
  return value.trim();
}

(async () => {
  const first = await ask('Attempt 1 — type TESTCLAN, Enter: ');
  console.log(`  FINAL(1)=${JSON.stringify(first)} length=${first.length}`);
  console.log('  (rejecting on purpose to force a retry, like the real bug)');
  const second = await ask('Attempt 2 — type TESTCLAN, Enter: ');
  console.log(`  FINAL(2)=${JSON.stringify(second)} length=${second.length}`);
  process.exit(0);
})();
