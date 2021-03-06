const fs = require('fs');
const path = require('path');
const hash = require('hash-sum');
const loaderUtils = require('loader-utils');
const tryRequire = require('vue-loader/lib/utils/try-require');

const genId = require('vue-loader/lib/utils/gen-id');
const styleCompilerPath = require.resolve('vue-loader/lib/style-compiler');
const templateCompilerPath = require.resolve('vue-loader/lib/template-compiler');
const componentNormalizerPath = require.resolve('vue-loader/lib/component-normalizer');

// check whether default js loader exists
const hasBabel = !!tryRequire('babel-loader');
const hasBuble = !!tryRequire('buble-loader');

module.exports = function (content) {
    this.cacheable();
    const isServer = this.options.target === 'node';
    const isProduction = this.minimize || process.env.NODE_ENV === 'production';

    const options = this.options.__vueOptions__ = Object.assign({}, this.options.vue, loaderUtils.getOptions(this));

    const vuePath = path.dirname(this.resourcePath);
    const vueName = path.basename(vuePath, '.vue');
    const vueDir = path.dirname(vuePath);

    const context = (this._compiler && this._compiler.context) || this.options.context || process.cwd();
    const moduleId = 'data-v-' + genId(vuePath, context, options.hashKey);

    const cssLoaderOptions = '?' + JSON.stringify({
        sourceMap: !isProduction && this.sourceMap && options.cssSourceMap !== false,
        minimize: isProduction,
        modules: true,
        importLoaders: 1,
        localIdentName: vueName + '_[local]',
    });

    const styleCompilerOptions = '?' + JSON.stringify({
        // a marker for vue-style-loader to know that this is an import from a vue file
        vue: true,
        id: moduleId,
        scoped: false,
        hasInlineConfig: !!options.postcss,
    });

    const bubleOptions = hasBuble && options.buble ? '?' + JSON.stringify(options.buble) : '';

    const templateCompilerOptions = '?' + JSON.stringify({
        id: moduleId,
        transformToRequire: options.transformToRequire,
        preserveWhitespace: options.preserveWhitespace,
        buble: options.buble,
        // only pass compilerModules if it's a path string
        compilerModules: typeof options.compilerModules === 'string' ? options.compilerModules : undefined,
    });

    const getRequirePath = (loader, filePath) => loaderUtils.stringifyRequest(this, '!!' + loader + '!' + filePath);
    const getRequire = (loader, filePath) => `require(${getRequirePath(loader, filePath)})`;

    const getCSSExtractLoader = () => {
        let extractor;
        const op = options.extractCSS;
        // extractCSS option is an instance of ExtractTextPlugin
        if (typeof op.extract === 'function')
            extractor = op;
        else {
            extractor = tryRequire('extract-text-webpack-plugin');
            if (!extractor)
                throw new Error('[vue-multifile-loader] extractCSS: true requires extract-text-webpack-plugin as a peer dependency.');
        }

        return extractor.extract({
            use: 'css-loader' + cssLoaderOptions + '!import-global-loader',
            fallback: 'vue-style-loader',
        });
    };

    const defaultLoaders = {
        html: templateCompilerPath + templateCompilerOptions,
        css: options.extractCSS ? getCSSExtractLoader() : 'vue-style-loader!css-loader' + cssLoaderOptions + '!' + styleCompilerPath + styleCompilerOptions + '!import-global-loader',
        /* eslint-disable no-nested-ternary */
        js: hasBuble ? ('buble-loader' + bubleOptions) : hasBabel ? 'babel-loader' : '',
    };

    // check if there are custom loaders specified via
    // webpack config, otherwise use defaults
    const loaders = Object.assign({}, defaultLoaders, options.loaders);

    /**
     * Start to output
     */
    let outputs = [];

    const needsHotReload = !isServer && !isProduction;
    if (needsHotReload)
        outputs.push('var disposed = false;');

    // add requires for styles
    let cssModules;

    // const files = fs.readdirSync(vuePath);
    // const cssFiles = files.filter((file) => file.endsWith('.css'));
    const cssModuleFilePath = path.join(vuePath, 'module.css');
    const cssIndexFilePath = path.join(vuePath, 'index.css');
    const cssModuleExists = fs.existsSync(cssModuleFilePath);
    const cssIndexExists = fs.existsSync(cssIndexFilePath);

    if (cssModuleExists || cssIndexExists) {
        const styleInjectionCodes = ['function injectStyle (ssrContext) {'];
        if (needsHotReload)
            styleInjectionCodes.push('    if (disposed) return;');
        if (isServer)
            styleInjectionCodes.push('var i;');

        const handleStyle = (filePath, moduleName) => {
            let requireString = getRequire(loaders.css, filePath);

            const hasStyleLoader = true;
            const hasVueStyleLoader = true;

            // vue-style-loader exposes inject functions during SSR so they are always called
            const invokeStyle = isServer && hasVueStyleLoader ? (code) => `;(i=${code},i.__inject__&&i.__inject__(ssrContext),i)\n` : (code) => `  ${code}\n`;

            // @TODO: Support other moduleName
            // const moduleName = '$style';
            // setCSSModule
            if (moduleName) {
                if (!cssModules) {
                    cssModules = {};
                    outputs.push('var cssModules = {};');
                }

                if (moduleName in cssModules) {
                    this.emitError(`CSS module name "${moduleName}" is not unique!`);
                    styleInjectionCodes.push(invokeStyle(requireString));
                } else {
                    cssModules[moduleName] = true;

                    // `(vue-)style-loader` exposes the name-to-hash map directly
                    // `css-loader` exposes it in `.locals`
                    // add `.locals` if the user configured to not use style-loader.
                    if (!hasStyleLoader)
                        requireString += '.locals';

                    styleInjectionCodes.push(`
                        cssModules["${moduleName}"] = ${requireString};
                        var superModules = this["${moduleName}"];
                        if (superModules && this.$options.name === superModules.root)
                            cssModules["${moduleName}"] = Object.assign({}, superModules, cssModules["${moduleName}"]);
                    `);

                    if (!needsHotReload)
                        styleInjectionCodes.push(invokeStyle(`this["${moduleName}"] = cssModules["${moduleName}"]`));
                    else {
                        // handle hot reload for CSS modules.
                        // we store the exported locals in an object and proxy to it by
                        // defining getters inside component instances' lifecycle hook.
                        styleInjectionCodes.push(invokeStyle(`cssModules["${moduleName}"]`));
                        styleInjectionCodes.push(`Object.defineProperty(this, "${moduleName}", {
                            get: function () { return cssModules["${moduleName}"] },
                            configurable: true,
                        });`);

                        const requirePath = getRequirePath(loaders.css, filePath);

                        outputs.push(`
                            module.hot && module.hot.accept([${requirePath}], function () {
                                // 1. check if style has been injected
                                var oldLocals = cssModules['${moduleName}'];
                                if (!oldLocals) return;
                                // 2. re-import (side effect: updates the <style>)
                                var newLocals = ${requireString};
                                // 3. compare new and old locals to see if selectors changed
                                if (JSON.stringify(newLocals) === JSON.stringify(oldLocals)) return;
                                // 4. locals changed. Update and force re-render.
                                cssModules['${moduleName}'] = newLocals;
                                require('vue-hot-reload-api').rerender('${moduleId}');
                            });
                            `);
                    }
                }
            } else
                styleInjectionCodes.push(invokeStyle(requireString));
        };

        cssModuleExists && handleStyle(cssModuleFilePath, '$style');
        cssIndexExists && handleStyle(cssIndexFilePath, false);

        styleInjectionCodes.push('}');
        outputs = outputs.concat(styleInjectionCodes);
    }

    // we require the component normalizer function, and call it like so:
    // normalizeComponent(
    //   scriptExports,
    //   compiledTemplate,
    //   injectStyles,
    //   scopeId,
    //   moduleIdentifier (server only)
    // )
    const componentRequirePath = loaderUtils.stringifyRequest(this, '!' + componentNormalizerPath);
    outputs.push(`var Component = require(${componentRequirePath})(`);

    // <script>
    outputs.push('/* script */');
    const jsFilePath = this.resourcePath;
    let scriptRequireString = getRequire(loaders.js, jsFilePath);
    // inject loader interop
    if (options.inject)
        scriptRequireString += '(injections)';
    outputs.push(scriptRequireString + ',');

    // <script>
    outputs.push('/* template */');
    // add require for template
    const htmlFilePath = path.join(vuePath, 'index.html');
    const htmlExists = fs.existsSync(htmlFilePath);
    if (htmlExists) {
        const templateRequireString = getRequire(loaders.html, htmlFilePath);
        outputs.push(templateRequireString + ',');
    } else
        outputs.push('null,');

    // style
    outputs.push('/* styles */');
    outputs.push((cssModuleExists || cssIndexExists ? 'injectStyle' : 'null') + ',');

    // @TODO: scopeId
    outputs.push('/* scopeId */');
    outputs.push('null,');

    // moduleIdentifier (server only)
    outputs.push('/* moduleIdentifier (server only) */');
    outputs.push(isServer ? JSON.stringify(hash(this.request)) : 'null');

    // close normalizeComponent call
    outputs.push(')');

    // development-only code
    if (!isProduction) {
        // add filename in dev
        outputs.push(`Component.options.__file = ${JSON.stringify(jsFilePath)};`);
        // check named exports
        outputs.push(`if (Component.esModule && Object.keys(Component.esModule).some(function (key) {
            return key !== "default" && key !== "__esModule"
        })) {
            console.error("named exports are not supported in *.vue files.");
        }`);
        // check functional components used with templates
        if (htmlExists) {
            outputs.push(`if (Component.options.functional) {
                console.error("[vue-multifile-loader] ${vueName}: functional components are not supported with templates, they should use render functions.");
            }`);
        }
    }

    // @TODO: add requires for customBlocks

    if (!options.inject) {
        // hot reload
        if (needsHotReload) {
            outputs.push(`
                /* hot reload */
                if (module.hot) {
                    (function () {
                        var hotAPI = require('vue-hot-reload-api');
                        hotAPI.install(require('vue'), false);
                        if (!hotAPI.compatible) return;
                        module.hot.accept();
                        if (!module.hot.data) {
                            hotAPI.createRecord('${moduleId}', Component.options);
                        } else {`
            );
            // update
            if (cssModules) {
                outputs.push(`if (module.hot.data.cssModules && Object.keys(module.hot.data.cssModules) !== Object.keys(cssModules)) {
                    delete Component.options._Ctor;
                }`);
            }
            outputs.push(`
                hotAPI.reload('${moduleId}', Component.options);
            }`);
            // dispose
            outputs.push('module.hot.dispose(function (data) {' + (cssModules ? 'data.cssModules = cssModules;' : '') + 'disposed = true; });');
            outputs.push('})()}');
        }

        // final export
        if (options.esModule) {
            outputs.push(`
                exports.__esModule = true;
                exports['default'] = Component.exports;
            `);
        } else
            outputs.push(`module.exports = Component.exports;`);
    } else {
        // inject-loader support
        return `/* dependency injection */
            module.exports = function (injections) {
                ${outputs.join('\n')}
                return Component.exports;
            };`;
    }

    // done
    return outputs.join('\n');
};
