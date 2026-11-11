// Signs Android release builds with the key named by these Gradle properties,
// normally set in ~/.gradle/gradle.properties so they stay out of the repo:
//
//   OPENSOUSVIDE_UPLOAD_STORE_FILE      path to the keystore (use forward slashes)
//   OPENSOUSVIDE_UPLOAD_STORE_PASSWORD
//   OPENSOUSVIDE_UPLOAD_KEY_ALIAS
//   OPENSOUSVIDE_UPLOAD_KEY_PASSWORD
//
// Without them, release builds fail at the signing step instead of falling back
// to the public debug key. Debug builds are unaffected.

const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = 'OPENSOUSVIDE_UPLOAD_STORE_FILE';

const RELEASE_SIGNING_CONFIG = `
        release {
            if (project.hasProperty('OPENSOUSVIDE_UPLOAD_STORE_FILE')) {
                storeFile file(OPENSOUSVIDE_UPLOAD_STORE_FILE)
                storePassword OPENSOUSVIDE_UPLOAD_STORE_PASSWORD
                keyAlias OPENSOUSVIDE_UPLOAD_KEY_ALIAS
                keyPassword OPENSOUSVIDE_UPLOAD_KEY_PASSWORD
            }
        }`;

function addReleaseSigning(gradle) {
  if (gradle.includes(MARKER)) return gradle;

  const debugConfig = /(signingConfigs \{\s*debug \{[^}]*\})/;
  if (!debugConfig.test(gradle)) {
    throw new Error('withReleaseSigning: could not find signingConfigs.debug in app/build.gradle');
  }
  gradle = gradle.replace(debugConfig, `$1${RELEASE_SIGNING_CONFIG}`);

  const releaseUsesDebug = /(release \{[^}]*?)signingConfig signingConfigs\.debug/;
  if (!releaseUsesDebug.test(gradle)) {
    throw new Error('withReleaseSigning: could not find the release build type signing config');
  }
  return gradle.replace(releaseUsesDebug, '$1signingConfig signingConfigs.release');
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = addReleaseSigning(config.modResults.contents);
    return config;
  });
};
