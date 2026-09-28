export default {
    verbose: true,
    transform: {
        '^.+\\.ts?$': 'ts-jest',
    },
    testEnvironment: 'jsdom',
    moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
};
