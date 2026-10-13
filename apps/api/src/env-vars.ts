// Loads .env when there is one (local development). Variables already set in
// the environment win, and Docker provides them without a file.
try {
  process.loadEnvFile();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw e;
  }
}
