import { defineConfig } from '@rslib/core';

export default defineConfig({
    lib: [
        {
            format: 'esm',
            syntax: 'es2022',
            dts: true,
            output: {
                distPath: {
                    root: './dist/esm',
                },
            },
        },
        {
            format: 'cjs',
            syntax: 'es2022',
            dts: false,
            output: {
                distPath: {
                    root: './dist/cjs',
                },
            },
        },
    ],
    source: {
        entry: {
            index: './src/index.ts',
            'core/index': './src/core/index.ts',
            'providers/index': './src/providers/index.ts',
            'prompts/index': './src/prompts/index.ts',
        },
    },
    output: {
        target: 'node',
    },
});