// Bundle the shared engine (packages/core, packages/crdt) straight from the monorepo,
// so the phone runs exactly the same budgeting code as the web app.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);

config.watchFolders = [path.join(root, 'packages/core'), path.join(root, 'packages/crdt')];
config.resolver.extraNodeModules = {
  '@envelope/core': path.join(root, 'packages/core'),
  '@envelope/crdt': path.join(root, 'packages/crdt'),
};
// Resolve dependencies of the shared packages from this app's node_modules only.
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];

module.exports = config;
