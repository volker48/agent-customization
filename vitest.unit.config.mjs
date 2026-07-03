export default {
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/*.e2e.test.ts",
      "tests/*.baseline.test.ts",
      "tests/remote-daemon.test.ts",
      "tests/remote-iroh-transport.test.ts",
    ],
  },
};
