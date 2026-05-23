// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Enforce consistent use of `const`
      "prefer-const": "error",
      // No unused vars (TS version handles typed vars too)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Explicit return types help readability in a CLI tool
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        { allowExpressions: true },
      ],
      // Consistent type assertions
      "@typescript-eslint/consistent-type-assertions": "error",
      // No explicit `any` — keeps the type safety meaningful
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
