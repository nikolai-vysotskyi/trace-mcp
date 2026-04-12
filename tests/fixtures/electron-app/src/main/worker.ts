// Utility process — runs in a forked child process
process.parentPort.on('message', (e) => {
  const { data } = e;
  console.log('Worker received:', data);

  // Process and send result back
  process.parentPort.postMessage({ result: 'done', input: data });
});
