export default {
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/*.e2e.test.ts",
      "tests/*.baseline.test.ts",
    ],
  },
};
