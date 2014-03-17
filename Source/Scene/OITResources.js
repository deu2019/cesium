/*global define*/
define([
        '../Core/defined',
        '../Core/destroyObject',
        '../Core/Color',
        '../Renderer/createShaderSource',
        '../Renderer/BlendFunction',
        '../Renderer/ClearCommand',
        '../Renderer/PixelDatatype',
        '../Renderer/PixelFormat',
        '../Renderer/RenderbufferFormat',
        '../Shaders/CompositeOITFS'
    ], function(
        defined,
        destroyObject,
        Color,
        createShaderSource,
        BlendFunction,
        ClearCommand,
        PixelDatatype,
        PixelFormat,
        RenderbufferFormat,
        CompositeOITFS) {
    "use strict";
    /*global WebGLRenderingContext*/

    /**
     * @private
     */
    var OITResources = function(context) {
        var textureFloat = context.getFloatingPointTexture();
        this._translucentMRTSupport = context.getDrawBuffers() && textureFloat;

        // We support multipass for the Chrome D3D9 backend and ES 2.0 on mobile.
        this._translucentMultipassSupport = !this._translucentMRTSupport && textureFloat;

        this._opaqueTexture = undefined;
        this._accumulationTexture = undefined;
        this._revealageTexture = undefined;

        this._depthTexture = undefined;
        this._depthRenderbuffer = undefined;

        this._opaqueFBO = undefined;
        this._translucentFBO = undefined;
        this._alphaFBO = undefined;

        var opaqueClearCommand = new ClearCommand();
        opaqueClearCommand.color = new Color(0.0, 0.0, 0.0, 0.0);
        opaqueClearCommand.depth = 1.0;
        opaqueClearCommand.owner = this;
        this._opaqueClearCommand = opaqueClearCommand;

        var translucentMRTClearCommand = new ClearCommand();
        translucentMRTClearCommand.color = new Color(0.0, 0.0, 0.0, 1.0);
        translucentMRTClearCommand.owner = this;
        this._translucentMRTClearCommand = translucentMRTClearCommand;

        var translucentMultipassClearCommand = new ClearCommand();
        translucentMultipassClearCommand.color = new Color(0.0, 0.0, 0.0, 0.0);
        translucentMultipassClearCommand.owner = this;
        this._translucentMultipassClearCommand = translucentMultipassClearCommand;

        var alphaClearCommand= new ClearCommand();
        alphaClearCommand.color = new Color(1.0, 1.0, 1.0, 1.0);
        alphaClearCommand.owner = this;
        this._alphaClearCommand = alphaClearCommand;

        this._translucentRenderStateCache = {};
        this._alphaRenderStateCache = {};
        this._translucentShaderCache = {};
        this._alphaShaderCache = {};
    };

    var translucentMRTBlend = {
        enabled : true,
        functionSourceRgb : BlendFunction.ONE,
        functionDestinationRgb : BlendFunction.ONE,
        functionSourceAlpha : BlendFunction.ZERO,
        functionDestinationAlpha : BlendFunction.ONE_MINUS_SOURCE_ALPHA
    };

    var translucentColorBlend = {
        enabled : true,
        functionSourceRgb : BlendFunction.ONE,
        functionDestinationRgb : BlendFunction.ONE,
        functionSourceAlpha : BlendFunction.ONE,
        functionDestinationAlpha : BlendFunction.ONE
    };

    var translucentAlphaBlend = {
        enabled : true,
        functionSourceRgb : BlendFunction.ZERO,
        functionDestinationRgb : BlendFunction.ONE_MINUS_SOURCE_ALPHA,
        functionSourceAlpha : BlendFunction.ZERO,
        functionDestinationAlpha : BlendFunction.ONE_MINUS_SOURCE_ALPHA
    };

    function getTranslucentRenderState(context, translucentBlending, cache, renderState) {
        var translucentState = cache[renderState.id];
        if (!defined(translucentState)) {
            var depthMask = renderState.depthMask;
            var blending = renderState.blending;

            renderState.depthMask = false;
            renderState.blending = translucentBlending;

            translucentState = context.createRenderState(renderState);
            cache[renderState.id] = translucentState;

            renderState.depthMask = depthMask;
            renderState.blending = blending;
        }

        return translucentState;
    }

    OITResources.prototype.getTranslucentMRTRenderState = function(context, renderState) {
        return getTranslucentRenderState(context, translucentMRTBlend, this._translucentRenderStateCache, renderState);
    };

    OITResources.prototype.getTranslucentColorRenderState = function(context, renderState) {
        return getTranslucentRenderState(context, translucentColorBlend, this._translucentRenderStateCache, renderState);
    };

    OITResources.prototype.getTranslucentAlphaRenderState = function(context, renderState) {
        return getTranslucentRenderState(context, translucentAlphaBlend, this._alphaRenderStateCache, renderState);
    };

    var mrtShaderSource =
        '    vec3 Ci = czm_gl_FragColor.rgb * czm_gl_FragColor.a;\n' +
        '    float ai = czm_gl_FragColor.a;\n' +
        '    float wzi = czm_alphaWeight(ai);\n' +
        '    gl_FragData[0] = vec4(Ci * wzi, ai);\n' +
        '    gl_FragData[1] = vec4(ai * wzi);\n';

    var colorShaderSource =
        '    vec3 Ci = czm_gl_FragColor.rgb * czm_gl_FragColor.a;\n' +
        '    float ai = czm_gl_FragColor.a;\n' +
        '    float wzi = czm_alphaWeight(ai);\n' +
        '    gl_FragColor = vec4(Ci, ai) * wzi;\n';

    var alphaShaderSource =
        '    float ai = czm_gl_FragColor.a;\n' +
        '    gl_FragColor = vec4(ai);\n';

    function getTranslucentShaderProgram(context, shaderProgram, cache, source) {
        var id = shaderProgram.id;
        var shader = cache[id];
        if (!defined(shader)) {
            var attributeLocations = shaderProgram._attributeLocations;
            var vs = shaderProgram.vertexShaderSource;
            var fs = shaderProgram.fragmentShaderSource;

            var renamedFS = fs.replace(/void\s+main\s*\(\s*(?:void)?\s*\)/g, 'void czm_translucent_main()');
            renamedFS = renamedFS.replace(/gl_FragColor/g, 'czm_gl_FragColor');
            renamedFS = renamedFS.replace(/discard/g, 'czm_discard = true');
            renamedFS = renamedFS.replace(/czm_phong/g, 'czm_translucentPhong');

            // Discarding the fragment in main is a workaround for ANGLE D3D9
            // shader compilation errors.
            var newSourceFS =
                (source.indexOf('gl_FragData') !== -1 ? '#extension GL_EXT_draw_buffers : enable \n' : '') +
                'vec4 czm_gl_FragColor;\n' +
                'bool czm_discard = false;\n' +
                renamedFS + '\n\n' +
                'void main()\n' +
                '{\n' +
                '    czm_translucent_main();\n' +
                '    if (czm_discard)\n' +
                '    {\n' +
                '        discard;\n' +
                '    }\n' +
                source +
                '}\n';

            shader = context.getShaderCache().getShaderProgram(vs, newSourceFS, attributeLocations);
            cache[id] = shader;
        }

        return shader;
    }

    OITResources.prototype.getTranslucentMRTShaderProgram = function(context, shaderProgram) {
        return getTranslucentShaderProgram(context, shaderProgram, this._translucentShaderCache, mrtShaderSource);
    };

    OITResources.prototype.getTranslucentColorShaderProgram = function(context, shaderProgram) {
        return getTranslucentShaderProgram(context, shaderProgram, this._translucentShaderCache, colorShaderSource);
    };

    OITResources.prototype.getTranslucentAlphaShaderProgram = function(context, shaderProgram) {
        return getTranslucentShaderProgram(context, shaderProgram, this._alphaShaderCache, alphaShaderSource);
    };

    function destroyResources(that) {
        that._opaqueFBO = that._opaqueFBO && that._opaqueFBO.destroy();
        that._translucentFBO = that._translucentFBO && that._translucentFBO.destroy();
        that._alphaFBO = that._alphaFBO && that._alphaFBO.destroy();

        that._opaqueTexture = that._opaqueTexture && that._opaqueTexture.destroy();
        that._accumulationTexture = that._accumulationTexture && that._accumulationTexture.destroy();
        that._revealageTexture = that._revealageTexture && that._revealageTexture.destroy();

        that._depthTexture = that._depthTexture && that._depthTexture.destroy();
        that._depthRenderbuffer = that._depthRenderbuffer && that._depthRenderbuffer.destroy();

        that._opaqueFBO = undefined;
        that._translucentFBO = undefined;
        that._alphaFBO = undefined;

        that._opaqueTexture = undefined;
        that._accumulationTexture = undefined;
        that._revealageTexture = undefined;

        that._depthTexture = undefined;
        that._depthRenderbuffer = undefined;
    }

    function updateTextures(that, context, width, height) {
        that._opaqueTexture = context.createTexture2D({
            width : width,
            height : height,
            pixelFormat : PixelFormat.RGB,
            pixelDatatype : PixelDatatype.UNSIGNED_BYTE
        });
        that._accumulationTexture = context.createTexture2D({
            width : width,
            height : height,
            pixelFormat : PixelFormat.RGBA,
            pixelDatatype : PixelDatatype.FLOAT
        });
        that._revealageTexture = context.createTexture2D({
            width : width,
            height : height,
            pixelFormat : PixelFormat.RGBA,
            pixelDatatype : PixelDatatype.FLOAT
        });

        if (context.getDepthTexture()) {
            that._depthTexture = context.createTexture2D({
                width : width,
                height : height,
                pixelFormat : PixelFormat.DEPTH_COMPONENT,
                pixelDatatype : PixelDatatype.UNSIGNED_SHORT
            });
        } else {
            that._depthRenderbuffer = context.createRenderbuffer({
                width : width,
                height : height,
                format : RenderbufferFormat.DEPTH_COMPONENT16
            });
        }
    }

    function updateFramebuffers(that, context) {
        that._opaqueFBO = context.createFramebuffer({
            colorTextures : [that._opaqueTexture],
            depthTexture : that._depthTexture,
            depthRenderbuffer : that._depthRenderbuffer,
            destroyAttachments : false
        });

        // if MRT is supported, attempt to make an FBO with multiple color attachments
        if (that._translucentMRTSupport) {
            that._translucentFBO = context.createFramebuffer({
                colorTextures : [that._accumulationTexture, that._revealageTexture],
                depthTexture : that._depthTexture,
                depthRenderbuffer : that._depthRenderbuffer,
                destroyAttachments : false
            });

            if (that._translucentFBO.getStatus() !== WebGLRenderingContext.FRAMEBUFFER_COMPLETE) {
                that._translucentFBO.destroy();
                that._translucentMRTSupport = false;
            }
        }

        // either MRT isn't supported or FBO creation failed, attempt multipass
        if (!that._translucentMRTSupport) {
            that._translucentFBO = context.createFramebuffer({
                colorTextures : [that._accumulationTexture],
                depthTexture : that._depthTexture,
                depthRenderbuffer : that._depthRenderbuffer,
                destroyAttachments : false
            });
            that._alphaFBO = context.createFramebuffer({
                colorTextures : [that._revealageTexture],
                depthTexture : that._depthTexture,
                depthRenderbuffer : that._depthRenderbuffer,
                destroyAttachments : false
            });

            var translucentStatus = that._translucentFBO.getStatus();
            var alphaStatus = that._alphaFBO.getStatus();
            if (translucentStatus !== WebGLRenderingContext.FRAMEBUFFER_COMPLETE || alphaStatus !== WebGLRenderingContext.FRAMEBUFFER_COMPLETE) {
                destroyResources(that);
                that._translucentMultipassSupport = false;
            }
        }
    }

    function updateCompositeCommand(that, context) {
        var fs = createShaderSource({
            defines : [that._translucentMRTSupport ? 'MRT' : ''],
            sources : [CompositeOITFS]
        });

        that._compositeCommand = context.createViewportQuadCommand(fs, context.createRenderState());
        that._compositeCommand.uniformMap = {
            u_opaque : function() {
                return that._opaqueTexture;
            },
            u_accumulation : function() {
                return that._accumulationTexture;
            },
            u_revealage : function() {
                return that._revealageTexture;
            }
        };
    }

    OITResources.prototype.update = function(context) {
        if (!this._translucentMRTSupport && !this._translucentMultipassSupport) {
            return;
        }

        var width = context.getDrawingBufferWidth();
        var height = context.getDrawingBufferHeight();

        var opaqueTexture = this._opaqueTexture;
        var textureChanged = !defined(opaqueTexture) || opaqueTexture.getWidth() !== width || opaqueTexture.getHeight() !== height;
        if (textureChanged) {
            updateTextures(this, context, width, height);
        }

        if (!defined(this._opaqueFBO)) {
            updateFramebuffers(this, context);

            // framebuffer creation failed
            if (!this._translucentMRTSupport && !this._translucentMultipassSupport) {
                return;
            }
        }

        if (!defined(this._compositeCommand)) {
            updateCompositeCommand(this, context);
        }
    };

    OITResources.prototype.clear = function(context, passState, clearColor) {
        if(!this.isSupported()) {
            return;
        }

        var framebuffer = passState.framebuffer;

        passState.framebuffer = this._opaqueFBO;
        Color.clone(clearColor, this._opaqueClearCommand.color);
        this._opaqueClearCommand.execute(context, passState);

        passState.framebuffer = this._translucentFBO;
        var translucentClearCommand = this._translucentMRTSupport ? this._translucentMRTClearCommand : this._translucentMultipassClearCommand;
        translucentClearCommand.execute(context, passState);

        if (this._translucentMultipassSupport) {
            passState.framebuffer = this._alphaFBO;
            this._alphaClearCommand.execute(context, passState);
        }

        passState.framebuffer = framebuffer;
    };

    OITResources.prototype.isSupported = function() {
        return this._translucentMRTSupport || this._translucentMultipassSupport;
    };

    OITResources.prototype.isDestroyed = function() {
        return false;
    };

    OITResources.prototype.destroy = function() {
        destroyResources(this);
        return destroyObject(this);
    };

    return OITResources;
});
