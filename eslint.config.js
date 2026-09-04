import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config.
 *
 * `tsc` already runs strict with `noUncheckedIndexedAccess`, `noUnusedLocals`
 * and `noUnusedParameters`, so it owns most of what a linter would say. These
 * rules cover what the type checker cannot see. Formatting is Prettier's job -
 * `eslint-config-prettier` turns off every stylistic rule so the two never
 * disagree.
 *
 * The rule set is deliberately small. `lint` has to stay green to stay useful:
 * a linter that reports a wall of pre-existing violations is one everybody
 * learns to scroll past. Rules disabled below are ones this codebase
 * contradicts *on purpose* - each says why, and each is a candidate for a
 * dedicated pass later, not a silent exemption.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/',
      'dist-demo/',
      'dist-viewer/',
      'dist-site/',
      '.wrangler/',
      'coverage/',
      'site/site-worker.js',
      'scripts/',
      '.cursor/',
      // Git-ignored tooling scratch (agent worktrees carry their own
      // node_modules and VitePress dep caches, which are not ours to lint).
      '.claude/',
      '.tmp/',
      'site/.vitepress/cache/',
      'site/.vitepress/dist/',
      'site/.vitepress/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The library holds no explicit `any`, and the standard is to keep it
      // that way: isolate a library-typing gap behind one commented cast.
      '@typescript-eslint/no-explicit-any': 'error',

      // tsc reports unused symbols; one owner avoids duplicate errors.
      '@typescript-eslint/no-unused-vars': 'off',

      // Submitting GPU work is fire-and-forget by design: `renderer.compute()`
      // returns a promise, and awaiting it in `update()` would stall the frame
      // it is meant to pipeline. The demo's UI calls are deliberately detached
      // for the same reason. Nothing here is an unhandled rejection.
      '@typescript-eslint/no-floating-promises': 'off',

      // ~75 non-null assertions predate the linter, most of them indexed reads
      // that `noUncheckedIndexedAccess` widens to `T | undefined`. Removing
      // them is a real refactor with real behaviour risk, not a lint fix.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // The parsers stringify already-rejected hostile input to name it in an
      // error message; "[object Object]" there is ugly, not wrong.
      '@typescript-eslint/no-base-to-string': 'off',

      // Async signatures are part of several public contracts (a parser may
      // decode synchronously today and stream tomorrow) and of the sorter
      // interface, where implementations differ.
      '@typescript-eslint/require-await': 'off',

      // three.js hands out methods as callbacks throughout.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Vitest's `expect(...).rejects` and structural casts into private members
    // make the strict-boolean/unsafe-argument rules noisy without adding cover.
    files: ['src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // Vite/Vitest configs sit outside the app's tsconfig `include` (which is
    // just `src`), so the type-aware rules have no program to consult.
    files: ['*.config.ts', '*.config.*.ts', '*.config.js', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
