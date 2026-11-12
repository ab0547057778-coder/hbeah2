const app = require("./lib/app");
const db = require("./lib/db");

const PORT = process.env.PORT || 3000;

db.getData().then(() => {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Microblading By Hebah running on http://localhost:${PORT}`);
    console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
  });
});
