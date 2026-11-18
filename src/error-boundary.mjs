// One throw in a request must not end the process: answer it if we still can, log it, and keep serving.
export function withErrorBoundary(listener) {
  return async (req, res) => {
    try {
      await listener(req, res);
    } catch (err) {
      console.error(`${req.method} ${req.url} failed: ${err.stack ?? err}`);
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    }
  };
}
