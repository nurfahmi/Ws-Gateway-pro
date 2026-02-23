module.exports = {
  apps: [
    {
      name: 'wa-gateway',
      script: 'src/index.js',
      node_args: '--experimental-specifier-resolution=node',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '10G',
    },
  ],
};
