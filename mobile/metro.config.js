// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Native builds write many files into these folders, both in android/ and in
// each native library under node_modules. Metro never needs them, and watching
// them during a Gradle build can stall it.
const nativeBuildOutput = /[\\/]android[\\/](?:app[\\/])?(?:build|\.cxx|\.gradle)(?:[\\/]|$)/;

config.resolver.blockList = [...[config.resolver.blockList].flat().filter(Boolean), nativeBuildOutput];

module.exports = config;
