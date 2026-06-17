import CopyPlugin from 'copy-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {(env: Record<string, string>, argv: Record<string, string>) => import('webpack').Configuration} */
const makeConfig = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    target: 'browserslist:chrome 60',
    devtool: isProd ? false : 'source-map',
    entry: './src/index.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'index.js',
      clean: true,
    },
    resolve: {
      extensions: ['.js', '.ts', '.json', '.css'],
    },
    module: {
      rules: [
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        {
          test: /\.(js|ts)$/,
          use: {
            loader: 'ts-loader',
            options: { transpileOnly: true },
          },
          resolve: {
            fullySpecified: false,
          },
          exclude: /node_modules/,
        },
        {
          test: /\.(png|svg|jpg|gif)$/,
          type: 'asset/resource',
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/index.html',
        inject: 'head',
        scriptLoading: 'blocking',
      }),
      new CopyPlugin({
        patterns: [
          {
            from: 'assets',
            to: 'assets',
            noErrorOnMissing: true,
          },
        ],
      }),
    ],
    optimization: {
      minimize: isProd,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            compress: { drop_console: isProd },
          },
        }),
      ],
    },
    devServer: {
      static: path.resolve(__dirname, 'dist'),
      port: 8080,
      hot: false,
      liveReload: true,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    },
  };
};

export default makeConfig;
