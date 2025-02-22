define(function(require) {
	'use strict';

	var BoundingSphere = require('Cesium/Core/BoundingSphere');
	var Cartesian3 = require('Cesium/Core/Cartesian3');
	var Color = require('Cesium/Core/Color');
	var combine = require('Cesium/Core/combine');
	var ComponentDatatype = require('Cesium/Core/ComponentDatatype');
	var defaultValue = require('Cesium/Core/defaultValue');
	var defined = require('Cesium/Core/defined');
	var destroyObject = require('Cesium/Core/destroyObject');
	var DeveloperError = require('Cesium/Core/DeveloperError');
	var Matrix4 = require('Cesium/Core/Matrix4');
	var PrimitiveType = require('Cesium/Core/PrimitiveType');
	var Buffer = require('Cesium/Renderer/Buffer');
	var BufferUsage = require('Cesium/Renderer/BufferUsage');
	var DrawCommand = require('Cesium/Renderer/DrawCommand');
	var Pass = require('Cesium/Renderer/Pass');
	var RenderState = require('Cesium/Renderer/RenderState');
	var ShaderProgram = require('Cesium/Renderer/ShaderProgram');
	var ShaderSource = require('Cesium/Renderer/ShaderSource');
	var VertexArray = require('Cesium/Renderer/VertexArray');
	var BlendingState = require('Cesium/Scene/BlendingState');
	var CullFace = require('Cesium/Scene/CullFace');
	var Material = require('Cesium/Scene/Material');
	var SceneMode = require('Cesium/Scene/SceneMode');

	var CustomSensorVolumeFS = require('text!./custom-sensor-volume-fs.glsl');
	var CustomSensorVolumeVS = require('text!./custom-sensor-volume-vs.glsl');
	var SensorVolume = require('text!../sensor-volume.glsl');

	var attributeLocations = {
		position: 0,
		normal: 1
	};

	var FAR = 5906376272000.0;  // distance from the Sun to Pluto in meters.

	/**
	 * DOC_TBA
	 *
	 * @alias CustomSensorVolume
	 * @constructor
	 */
	var CustomSensorVolume = function(options) {
		options = defaultValue(options, defaultValue.EMPTY_OBJECT);

		this._pickId = undefined;
		this._pickPrimitive = defaultValue(options._pickPrimitive, this);

		this._frontFaceColorCommand = new DrawCommand();
		this._backFaceColorCommand = new DrawCommand();
		this._pickCommand = new DrawCommand();

		this._boundingSphere = new BoundingSphere();
		this._boundingSphereWC = new BoundingSphere();

		this._frontFaceColorCommand.primitiveType = PrimitiveType.TRIANGLES;
		this._frontFaceColorCommand.boundingVolume = this._boundingSphereWC;
		this._frontFaceColorCommand.owner = this;

		this._backFaceColorCommand.primitiveType = this._frontFaceColorCommand.primitiveType;
		this._backFaceColorCommand.boundingVolume = this._frontFaceColorCommand.boundingVolume;
		this._backFaceColorCommand.owner = this;

		this._pickCommand.primitiveType = this._frontFaceColorCommand.primitiveType;
		this._pickCommand.boundingVolume = this._frontFaceColorCommand.boundingVolume;
		this._pickCommand.owner = this;

		/**
		 * <code>true</code> if this sensor will be shown; otherwise, <code>false</code>
		 *
		 * @type {Boolean}
		 * @default true
		 */
		this.show = defaultValue(options.show, true);

		/**
		 * When <code>true</code>, a polyline is shown where the sensor outline intersections the globe.
		 *
		 * @type {Boolean}
		 *
		 * @default true
		 *
		 * @see CustomSensorVolume#intersectionColor
		 */
		this.showIntersection = defaultValue(options.showIntersection, true);

		/**
		 * <p>
		 * Determines if a sensor intersecting the ellipsoid is drawn through the ellipsoid and potentially out
		 * to the other side, or if the part of the sensor intersecting the ellipsoid stops at the ellipsoid.
		 * </p>
		 *
		 * @type {Boolean}
		 * @default false
		 */
		this.showThroughEllipsoid = defaultValue(options.showThroughEllipsoid, false);
		this._showThroughEllipsoid = this.showThroughEllipsoid;

		/**
		 * The 4x4 transformation matrix that transforms this sensor from model to world coordinates.  In it's model
		 * coordinates, the sensor's principal direction is along the positive z-axis.  The clock angle, sometimes
		 * called azimuth, is the angle in the sensor's X-Y plane measured from the positive X-axis toward the positive
		 * Y-axis.  The cone angle, sometimes called elevation, is the angle out of the X-Y plane along the positive Z-axis.
		 * <br /><br />
		 * <div align='center'>
		 * <img src='images/CustomSensorVolume.setModelMatrix.png' /><br />
		 * Model coordinate system for a custom sensor
		 * </div>
		 *
		 * @type {Matrix4}
		 * @default {@link Matrix4.IDENTITY}
		 *
		 * @example
		 * // The sensor's vertex is located on the surface at -75.59777 degrees longitude and 40.03883 degrees latitude.
		 * // The sensor's opens upward, along the surface normal.
		 * var center = Cesium.Cartesian3.fromDegrees(-75.59777, 40.03883);
		 * sensor.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(center);
		 */
		this.modelMatrix = Matrix4.clone(defaultValue(options.modelMatrix, Matrix4.IDENTITY));
		this._modelMatrix = new Matrix4();

		/**
		 * DOC_TBA
		 *
		 * @type {Number}
		 * @default {@link Number.POSITIVE_INFINITY}
		 */
		this.radius = defaultValue(options.radius, Number.POSITIVE_INFINITY);

		this._directions = undefined;
		this._directionsDirty = false;
		this.directions = defined(options.directions) ? options.directions : [];

		/**
		 * The surface appearance of the sensor.  This can be one of several built-in {@link Material} objects or a custom material, scripted with
		 * {@link https://github.com/AnalyticalGraphicsInc/cesium/wiki/Fabric|Fabric}.
		 * <p>
		 * The default material is <code>Material.ColorType</code>.
		 * </p>
		 *
		 * @type {Material}
		 * @default Material.fromType(Material.ColorType)
		 *
		 * @see {@link https://github.com/AnalyticalGraphicsInc/cesium/wiki/Fabric|Fabric}
		 *
		 * @example
		 * // 1. Change the color of the default material to yellow
		 * sensor.lateralSurfaceMaterial.uniforms.color = new Cesium.Color(1.0, 1.0, 0.0, 1.0);
		 *
		 * // 2. Change material to horizontal stripes
		 * sensor.lateralSurfaceMaterial = Cesium.Material.fromType(Material.StripeType);
		 */
		this.lateralSurfaceMaterial = defined(options.lateralSurfaceMaterial) ? options.lateralSurfaceMaterial : Material.fromType(Material.ColorType);
		this._lateralSurfaceMaterial = undefined;
		this._translucent = undefined;

		/**
		 * The color of the polyline where the sensor outline intersects the globe.  The default is {@link Color.WHITE}.
		 *
		 * @type {Color}
		 * @default {@link Color.WHITE}
		 *
		 * @see CustomSensorVolume#showIntersection
		 */
		this.intersectionColor = Color.clone(defaultValue(options.intersectionColor, Color.WHITE));

		/**
		 * The approximate pixel width of the polyline where the sensor outline intersects the globe.  The default is 5.0.
		 *
		 * @type {Number}
		 * @default 5.0
		 *
		 * @see CustomSensorVolume#showIntersection
		 */
		this.intersectionWidth = defaultValue(options.intersectionWidth, 5.0);

		/**
		 * User-defined object returned when the sensors is picked.
		 *
		 * @type Object
		 *
		 * @default undefined
		 *
		 * @see Scene#pick
		 */
		this.id = options.id;
		this._id = undefined;

		var that = this;

		/* eslint-disable camelcase */
		this._uniforms = {
			u_showThroughEllipsoid: function() {
				return that.showThroughEllipsoid;
			},
			u_showIntersection: function() {
				return that.showIntersection;
			},
			u_sensorRadius: function() {
				return isFinite(that.radius) ? that.radius : FAR;
			},
			u_intersectionColor: function() {
				return that.intersectionColor;
			},
			u_intersectionWidth: function() {
				return that.intersectionWidth;
			},
			u_normalDirection: function() {
				return 1.0;
			}
		};
		/* eslint-enable camelcase */

		this._mode = SceneMode.SCENE3D;
	};

	Object.defineProperties(CustomSensorVolume.prototype, {
		directions: {
			get: function() {
				return this._directions;
			},
			set: function(value) {
				this._directions = value;
				this._directionsDirty = true;
			}
		}
	});

	var n0Scratch = new Cartesian3();
	var n1Scratch = new Cartesian3();
	var n2Scratch = new Cartesian3();
	function computePositions(customSensorVolume) {
		var directions = customSensorVolume._directions;
		var length = directions.length;
		var positions = new Float32Array(3 * length);
		var r = isFinite(customSensorVolume.radius) ? customSensorVolume.radius : FAR;

		var boundingVolumePositions = [Cartesian3.ZERO];

		for (var i = length - 2, j = length - 1, k = 0; k < length; i = j++, j = k++) {
			// PERFORMANCE_IDEA:  We can avoid redundant operations for adjacent edges.
			var n0 = Cartesian3.fromSpherical(directions[i], n0Scratch);
			var n1 = Cartesian3.fromSpherical(directions[j], n1Scratch);
			var n2 = Cartesian3.fromSpherical(directions[k], n2Scratch);

			// Extend position so the volume encompasses the sensor's radius.
			var theta = Math.max(Cartesian3.angleBetween(n0, n1), Cartesian3.angleBetween(n1, n2));
			var distance = r / Math.cos(theta * 0.5);
			var p = Cartesian3.multiplyByScalar(n1, distance, new Cartesian3());

			positions[(j * 3)] = p.x;
			positions[(j * 3) + 1] = p.y;
			positions[(j * 3) + 2] = p.z;

			boundingVolumePositions.push(p);
		}

		BoundingSphere.fromPoints(boundingVolumePositions, customSensorVolume._boundingSphere);

		return positions;
	}

	var nScratch = new Cartesian3();
	function createVertexArray(customSensorVolume, context) {
		var positions = computePositions(customSensorVolume);

		var length = customSensorVolume._directions.length;
		var vertices = new Float32Array(2 * 3 * 3 * length);

		var k = 0;
		for (var i = length - 1, j = 0; j < length; i = j++) {
			var p0 = new Cartesian3(positions[(i * 3)], positions[(i * 3) + 1], positions[(i * 3) + 2]);
			var p1 = new Cartesian3(positions[(j * 3)], positions[(j * 3) + 1], positions[(j * 3) + 2]);
			var n = Cartesian3.normalize(Cartesian3.cross(p1, p0, nScratch), nScratch); // Per-face normals

			vertices[k++] = 0.0; // Sensor vertex
			vertices[k++] = 0.0;
			vertices[k++] = 0.0;
			vertices[k++] = n.x;
			vertices[k++] = n.y;
			vertices[k++] = n.z;

			vertices[k++] = p1.x;
			vertices[k++] = p1.y;
			vertices[k++] = p1.z;
			vertices[k++] = n.x;
			vertices[k++] = n.y;
			vertices[k++] = n.z;

			vertices[k++] = p0.x;
			vertices[k++] = p0.y;
			vertices[k++] = p0.z;
			vertices[k++] = n.x;
			vertices[k++] = n.y;
			vertices[k++] = n.z;
		}

		var vertexBuffer = Buffer.createVertexBuffer({
			context: context,
			typedArray: new Float32Array(vertices),
			usage: BufferUsage.STATIC_DRAW
		});

		var stride = 2 * 3 * Float32Array.BYTES_PER_ELEMENT;

		var attributes = [{
			index: attributeLocations.position,
			vertexBuffer: vertexBuffer,
			componentsPerAttribute: 3,
			componentDatatype: ComponentDatatype.FLOAT,
			offsetInBytes: 0,
			strideInBytes: stride
		}, {
			index: attributeLocations.normal,
			vertexBuffer: vertexBuffer,
			componentsPerAttribute: 3,
			componentDatatype: ComponentDatatype.FLOAT,
			offsetInBytes: 3 * Float32Array.BYTES_PER_ELEMENT,
			strideInBytes: stride
		}];

		return new VertexArray({
			context: context,
			attributes: attributes
		});
	}

	/**
	 * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
	 * get the draw commands needed to render this primitive.
	 * <p>
	 * Do not call this function directly.  This is documented just to
	 * list the exceptions that may be propagated when the scene is rendered:
	 * </p>
	 *
	 * @exception {DeveloperError} this.radius must be greater than or equal to zero.
	 * @exception {DeveloperError} this.lateralSurfaceMaterial must be defined.
	 */
	CustomSensorVolume.prototype.update = function(frameState) {
		this._mode = frameState.mode;
		if (!this.show || this._mode !== SceneMode.SCENE3D) {
			return;
		}

		var context = frameState.context;
		var commandList = frameState.commandList;

		// >>includeStart('debug', pragmas.debug);
		if (this.radius < 0.0) {
			throw new DeveloperError('this.radius must be greater than or equal to zero.');
		}
		if (!defined(this.lateralSurfaceMaterial)) {
			throw new DeveloperError('this.lateralSurfaceMaterial must be defined.');
		}
		// >>includeEnd('debug');

		var translucent = this.lateralSurfaceMaterial.isTranslucent();

		// Initial render state creation
		if ((this._showThroughEllipsoid !== this.showThroughEllipsoid) ||
			(!defined(this._frontFaceColorCommand.renderState)) ||
			(this._translucent !== translucent)
		) {
			this._showThroughEllipsoid = this.showThroughEllipsoid;
			this._translucent = translucent;

			var rs;

			if (translucent) {
				rs = RenderState.fromCache({
					depthTest: {
						// This would be better served by depth testing with a depth buffer that does not
						// include the ellipsoid depth - or a g-buffer containing an ellipsoid mask
						// so we can selectively depth test.
						enabled: !this.showThroughEllipsoid
					},
					depthMask: false,
					blending: BlendingState.ALPHA_BLEND,
					cull: {
						enabled: true,
						face: CullFace.BACK
					}
				});

				this._frontFaceColorCommand.renderState = rs;
				this._frontFaceColorCommand.pass = Pass.TRANSLUCENT;

				rs = RenderState.fromCache({
					depthTest: {
						enabled: !this.showThroughEllipsoid
					},
					depthMask: false,
					blending: BlendingState.ALPHA_BLEND,
					cull: {
						enabled: true,
						face: CullFace.FRONT
					}
				});

				this._backFaceColorCommand.renderState = rs;
				this._backFaceColorCommand.pass = Pass.TRANSLUCENT;

				rs = RenderState.fromCache({
					depthTest: {
						enabled: !this.showThroughEllipsoid
					},
					depthMask: false,
					blending: BlendingState.ALPHA_BLEND
				});
				this._pickCommand.renderState = rs;
			} else {
				rs = RenderState.fromCache({
					depthTest: {
						enabled: true
					},
					depthMask: true
				});
				this._frontFaceColorCommand.renderState = rs;
				this._frontFaceColorCommand.pass = Pass.OPAQUE;

				rs = RenderState.fromCache({
					depthTest: {
						enabled: true
					},
					depthMask: true
				});
				this._pickCommand.renderState = rs;
			}
		}

		// Recreate vertex buffer when directions change
		var directionsChanged = this._directionsDirty;
		if (directionsChanged) {
			this._directionsDirty = false;
			this._va = this._va && this._va.destroy();

			var directions = this._directions;
			if (directions && (directions.length >= 3)) {
				this._frontFaceColorCommand.vertexArray = createVertexArray(this, context);
				this._backFaceColorCommand.vertexArray = this._frontFaceColorCommand.vertexArray;
				this._pickCommand.vertexArray = this._frontFaceColorCommand.vertexArray;
			}
		}

		if (!defined(this._frontFaceColorCommand.vertexArray)) {
			return;
		}

		var pass = frameState.passes;

		var modelMatrixChanged = !Matrix4.equals(this.modelMatrix, this._modelMatrix);
		if (modelMatrixChanged) {
			Matrix4.clone(this.modelMatrix, this._modelMatrix);
		}

		if (directionsChanged || modelMatrixChanged) {
			BoundingSphere.transform(this._boundingSphere, this.modelMatrix, this._boundingSphereWC);
		}

		this._frontFaceColorCommand.modelMatrix = this.modelMatrix;
		this._backFaceColorCommand.modelMatrix = this._frontFaceColorCommand.modelMatrix;
		this._pickCommand.modelMatrix = this._frontFaceColorCommand.modelMatrix;

		var materialChanged = this._lateralSurfaceMaterial !== this.lateralSurfaceMaterial;
		this._lateralSurfaceMaterial = this.lateralSurfaceMaterial;
		this._lateralSurfaceMaterial.update(context);

		if (pass.render) {
			var frontFaceColorCommand = this._frontFaceColorCommand;
			var backFaceColorCommand = this._backFaceColorCommand;

			// Recompile shader when material changes
			if (materialChanged || !defined(frontFaceColorCommand.shaderProgram)) {
				var fsSource = new ShaderSource({
					sources: [SensorVolume, this._lateralSurfaceMaterial.shaderSource, CustomSensorVolumeFS]
				});

				frontFaceColorCommand.shaderProgram = ShaderProgram.replaceCache({
					context: context,
					shaderProgram: frontFaceColorCommand.shaderProgram,
					vertexShaderSource: CustomSensorVolumeVS,
					fragmentShaderSource: fsSource,
					attributeLocations: attributeLocations
				});

				frontFaceColorCommand.uniformMap = combine(this._uniforms, this._lateralSurfaceMaterial._uniforms);

				backFaceColorCommand.shaderProgram = frontFaceColorCommand.shaderProgram;
				backFaceColorCommand.uniformMap = combine(this._uniforms, this._lateralSurfaceMaterial._uniforms);
				// eslint-disable-next-line camelcase
				backFaceColorCommand.uniformMap.u_normalDirection = function() {
					return -1.0;
				};
			}

			if (translucent) {
				commandList.push(this._backFaceColorCommand, this._frontFaceColorCommand);
			} else {
				commandList.push(this._frontFaceColorCommand);
			}
		}

		if (pass.pick) {
			var pickCommand = this._pickCommand;

			if (!defined(this._pickId) || (this._id !== this.id)) {
				this._id = this.id;
				this._pickId = this._pickId && this._pickId.destroy();
				this._pickId = context.createPickId({
					primitive: this._pickPrimitive,
					id: this.id
				});
			}

			// Recompile shader when material changes
			if (materialChanged || !defined(pickCommand.shaderProgram)) {
				var pickFS = new ShaderSource({
					sources: [SensorVolume, this._lateralSurfaceMaterial.shaderSource, CustomSensorVolumeFS],
					pickColorQualifier: 'uniform'
				});

				pickCommand.shaderProgram = ShaderProgram.replaceCache({
					context: context,
					shaderProgram: pickCommand.shaderProgram,
					vertexShaderSource: CustomSensorVolumeVS,
					fragmentShaderSource: pickFS,
					attributeLocations: attributeLocations
				});

				var that = this;
				var uniforms = {
					// eslint-disable-next-line camelcase
					czm_pickColor: function() {
						return that._pickId.color;
					}
				};
				pickCommand.uniformMap = combine(combine(this._uniforms, this._lateralSurfaceMaterial._uniforms), uniforms);
			}

			pickCommand.pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;
			commandList.push(pickCommand);
		}
	};

	/**
	 * DOC_TBA
	 */
	CustomSensorVolume.prototype.isDestroyed = function() {
		return false;
	};

	/**
	 * DOC_TBA
	 */
	CustomSensorVolume.prototype.destroy = function() {
		this._frontFaceColorCommand.vertexArray = this._frontFaceColorCommand.vertexArray && this._frontFaceColorCommand.vertexArray.destroy();
		this._frontFaceColorCommand.shaderProgram = this._frontFaceColorCommand.shaderProgram && this._frontFaceColorCommand.shaderProgram.destroy();
		this._pickCommand.shaderProgram = this._pickCommand.shaderProgram && this._pickCommand.shaderProgram.destroy();
		this._pickId = this._pickId && this._pickId.destroy();
		return destroyObject(this);
	};

	return CustomSensorVolume;
});
