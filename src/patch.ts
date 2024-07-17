import { GPURayTracingAccelerationContainer_top_Impl } from "./accel_container";
import { aggregateAndCompileShaders } from "./compile";
import { _GPURayTracingAccelerationContainerUsage, _GPURayTracingAccelerationGeometryUsage, _GPURayTracingAccelerationInstanceUsage, _GPUShaderStageRTX } from "./types";
import GPURayTracingPassEncoder, { GPUBindGroupWithAccelerationContainer } from "./pass_encoder";
import { GPURayTracingPipelineImpl } from "./pipeline";
import { _GPUBufferExtra, allocateStagingBuffer } from "./wasm_bvh_builder";

//! looks like glslang force entry point to be 'main'
const SHADER_ENTRY_POINT = 'main';

let _dummyASUniformBuffer: GPUBuffer | undefined;
function _getDummyASUniformBuffer(device: GPUDevice): GPUBuffer {
  if (_dummyASUniformBuffer) {
    return _dummyASUniformBuffer;
  }
  _dummyASUniformBuffer = device.createBuffer({
    size: 2 * 4,
    usage: GPUBufferUsage.UNIFORM,
    mappedAtCreation: true,
  });
  // std140
  // endianness does not matter
  new Uint32Array(_dummyASUniformBuffer.getMappedRange()).set(
    [
      0, 0,
    ]);
  _dummyASUniformBuffer.unmap();
  return _dummyASUniformBuffer;
}

const _state = {
  extensionEnabled: false,
};

if (typeof GPUAdapter !== 'undefined') {
  const _original = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (descriptor?: GPUDeviceDescriptor) {
    let features, index;
    if (descriptor?.requiredFeatures && (index = (features = Array.from(descriptor.requiredFeatures)).indexOf('ray_tracing' as GPUFeatureName)) !== -1) {
      _state.extensionEnabled = true;
      features.splice(index, 1);
      descriptor.requiredFeatures = features;

      patch();
    }
    return _original.call(this, descriptor);
  };
}

function patch() {
  // A SBT entry is made of a program ID and a set of 4-byte parameters (see shaderRecordEXT).
  (GPUDevice.prototype.ShaderGroupHandleSize as number) = 4; // bytes
  (GPUDevice.prototype.ShaderGroupBaseAlignment as number) = 64; // bytes
  (GPUDevice.prototype.ShaderGroupHandleAlignment as number) = 32; // bytes
  (GPUDevice.prototype.ShaderGroupRecordMaxStride as number) = 4096; // bytes

  // globalThis['WEBRTX_SHADER_UNUSED'] = 0xff;
  globalThis['WEBRTX_HIT_GROUP_ALL_SHADERS_UNUSED_HANDLE'] = 0xffffff;
  globalThis['GPURayTracingAccelerationContainerUsage'] = {
    NONE: 0 as _GPURayTracingAccelerationContainerUsage,
    // ALLOW_UPDATE: 1 as _GPURayTracingAccelerationContainerUsage,
    // ALLOW_COMPACTION: 2 as _GPURayTracingAccelerationContainerUsage,
    // PREFER_FAST_TRACE: 4 as _GPURayTracingAccelerationContainerUsage,
    // PREFER_FAST_BUILD: 8 as _GPURayTracingAccelerationContainerUsage,
    // LOW_MEMORY: 0x10 as _GPURayTracingAccelerationContainerUsage,
  };
  globalThis['GPURayTracingAccelerationGeometryUsage'] = {
    NONE: 0 as _GPURayTracingAccelerationGeometryUsage,
    // OPAQUE: 1 as _GPURayTracingAccelerationGeometryUsage,
    // NO_DUPLICATE_ANY_HIT_INVOCATION: 2 as _GPURayTracingAccelerationGeometryUsage,
  };
  globalThis['GPURayTracingAccelerationInstanceUsage'] = {
    NONE: 0 as _GPURayTracingAccelerationInstanceUsage,
    // TRIANGLE_FACING_CULL_DISABLE: 1 as _GPURayTracingAccelerationInstanceUsage,
    // TRIANGLE_FRONT_COUNTERCLOCKWISE: 2 as _GPURayTracingAccelerationInstanceUsage,
    // FORCE_OPAQUE: 4 as _GPURayTracingAccelerationInstanceUsage,
    // FORCE_NO_OPAQUE: 8 as _GPURayTracingAccelerationInstanceUsage,
  };

  const _maxGPUBufferUsage = Math.max(...(Object.values(GPUBufferUsage) as number[]));
  const _maxGPUShaderStage = Math.max(...(Object.values(GPUShaderStage) as number[]));
  globalThis['GPUBufferUsageRTX'] = {
    ACCELERATION_STRUCTURE_BUILD_INPUT_READONLY: (_maxGPUBufferUsage << 1) as GPUFlagsConstant,
    // AS_STORAGE: (_maxGPUBufferUsage << 2) as GPUFlagsConstant,
    SHADER_BINDING_TABLE: (_maxGPUBufferUsage << 3) as GPUFlagsConstant,
  };
  const _extStages = {
    RAY_GENERATION: (_maxGPUShaderStage << 1) as _GPUShaderStageRTX,
    RAY_ANY_HIT: (_maxGPUShaderStage << 2) as _GPUShaderStageRTX,
    RAY_CLOSEST_HIT: (_maxGPUShaderStage << 3) as _GPUShaderStageRTX,
    RAY_MISS: (_maxGPUShaderStage << 4) as _GPUShaderStageRTX,
    RAY_INTERSECTION: (_maxGPUShaderStage << 5) as _GPUShaderStageRTX,
  };
  globalThis['GPUShaderStageRTX'] = _extStages;
  const ALL_RT_EXT_SHADER_STAGES = 0
    | _extStages.RAY_GENERATION
    | _extStages.RAY_ANY_HIT
    | _extStages.RAY_CLOSEST_HIT
    | _extStages.RAY_MISS
    | _extStages.RAY_INTERSECTION;

  const _originals = {
    GPUDevice_createBindGroupLayout: GPUDevice.prototype.createBindGroupLayout,
    GPUDevice_createBindGroup: GPUDevice.prototype.createBindGroup,
    GPUDevice_createBuffer: GPUDevice.prototype.createBuffer,
  };

  GPUDevice.prototype.createBindGroup = function (
    descriptor: GPUBindGroupDescriptor
  ): GPUBindGroup {
    let onlyAS: GPURayTracingAccelerationContainer_top_Impl | undefined;
    const entries = Array.from(descriptor.entries);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const a = entry.resource;
      if (!a || !(a instanceof GPURayTracingAccelerationContainer_top_Impl)) {
        continue;
      }
      if (onlyAS) {
        throw 'only support single GPURayTracingAccelerationContainer_top in bind group'
      }
      onlyAS = a;
      //! // TODO: should validate against layout
      entry.resource = {
        buffer: _getDummyASUniformBuffer(this),
      };
    }
    descriptor.entries = entries;
    const bg = _originals.GPUDevice_createBindGroup.call(this, descriptor);
    if (onlyAS) {
      (bg as GPUBindGroupWithAccelerationContainer).__accel_container = onlyAS;
    }
    return bg;
  }

  // WebGPU의 createBuffer 재정의
  GPUDevice.prototype.createBuffer = function (
    descriptor: GPUBufferDescriptor
  ): GPUBuffer {
    let createStagingBuffer = false;
    if (descriptor.usage & GPUBufferUsageRTX.ACCELERATION_STRUCTURE_BUILD_INPUT_READONLY) {
      descriptor.usage &= ~GPUBufferUsageRTX.ACCELERATION_STRUCTURE_BUILD_INPUT_READONLY;
      descriptor.usage |= GPUBufferUsage.STORAGE;
      //! STORAGE cannot be used together with MAP_READ, need to copy buffer
      // TODO: any other way to read the buffer? // e.g. device.queue.writeBuffer
      // descriptor.usage |= (GPUBufferUsage.STORAGE | GPUBufferUsage.MAP_READ);
      createStagingBuffer = true;
    }
    if (descriptor.usage & GPUBufferUsageRTX.SHADER_BINDING_TABLE) {
      descriptor.usage &= ~GPUBufferUsageRTX.SHADER_BINDING_TABLE;
      descriptor.usage |= GPUBufferUsage.STORAGE;
      // TODO: see above
    }
    // 원본의 createBuffer 호출
    const buffer = _originals.GPUDevice_createBuffer.call(this, descriptor);

    // 만약 WebRTX의 기능을 써야한다면
    if (createStagingBuffer) {
      buffer.mapAsync = () => {
        throw new Error('not implemented - cannot use mapAsync with ACCELERATION_STRUCTURE_BUILD_INPUT_READONLY');
      };
      const originalFunctions = {
        getMappedRange: buffer.getMappedRange,
        unmap: buffer.unmap,
      };
      // descriptor와 동일 사이즈의 임시 버퍼인 stagingbuffer를 할당
      (buffer as _GPUBufferExtra).__staging = allocateStagingBuffer(descriptor.size);

      // getMappedRange 재정의
      buffer.getMappedRange = (
        offset?: GPUSize64,
        size?: GPUSize64
      ): ArrayBuffer => {
        // original getMappedRange 호출
        // 항상 arraybuffer를 주는데, arraybuffer가 유일하게 memory continuous한 자료구조이기 때문이다.
        const mapped = originalFunctions.getMappedRange.call(buffer, offset, size);
        // 버퍼의 __lastMapped에 getMappedRange에서 반환된 ArrayBuffer 및 offset을 저장
        (buffer as _GPUBufferExtra).__lastMapped = {
          mapped,
          offset,
        };
        return mapped;
      };
      
      // unmap 재정의, 이 시점에 gpu로 완전히 넘긴다.
      // Copy data to staging buffer before unmapping.
      buffer.unmap = (): undefined => {
        const offset = (buffer as _GPUBufferExtra).__lastMapped?.offset || 0;
        // 여기서 __staging!의 !는 이 변수가 이 시점에 항상 값이 있다는 것을 의미한다. 즉, undefined가 아니라는 것.
        const staging = (buffer as _GPUBufferExtra).__staging!;
        // Copy whole mapped buffer to offset in staging
        // 스테이징 버퍼에 데이터를 넘기고 원본 mapped 버퍼를 삭제
        (staging.u8_view() as Uint8Array).set(new Uint8Array((buffer as _GPUBufferExtra).__lastMapped!.mapped), offset);
        delete (buffer as _GPUBufferExtra).__lastMapped;
        // 이후 원본의 unmap 호출
        originalFunctions.unmap.call(buffer);
        return;
      };
    }
    return buffer;
  }

  // Tlas is currently required to properly set # of geometries in the combined shader code.
  // TODO: decouple tlas from ray tracing pipeline creation
  GPUDevice.prototype.createRayTracingPipeline = async function (
    descriptor: GPURayTracingPipelineDescriptor,
    todo_drop_tlas: GPURayTracingAccelerationContainer_top,
  ): Promise<GPURayTracingPipeline> {
    const [megaShaderModule, nextUnusedBindSet] = await aggregateAndCompileShaders(this, descriptor, todo_drop_tlas);
    return new GPURayTracingPipelineImpl(descriptor, todo_drop_tlas, this.createComputePipeline({
      // TODO: allow layout
      layout: 'auto',
      compute: {
        module: megaShaderModule,
        entryPoint: SHADER_ENTRY_POINT,
      },
    }), nextUnusedBindSet);
  }

  GPUCommandEncoder.prototype.beginRayTracingPass = function (): GPURayTracingPassEncoder {
    return new GPURayTracingPassEncoder(this.beginComputePass());
  }

  // NOTE: this would create one buffer that maps to the TLAS, BLASes will not have corresponding GPU resources,
  // reusing BLASes across TLASes would duplicate those BLASes.
  // 실제로 tlas 및 blas의 descriptor로 객체를 생성
  GPUDevice.prototype.createRayTracingAccelerationContainer = function (descriptor: GPURayTracingAccelerationContainerDescriptor_top): GPURayTracingAccelerationContainer_top {
    return new GPURayTracingAccelerationContainer_top_Impl(descriptor);
  }

  // We actually build accel on host and upload to GPU buffer.
  // 실제로 Acceleration Strcture를 생성
  GPUDevice.prototype.hostBuildRayTracingAccelerationContainer = function (container: GPURayTracingAccelerationContainer_top): void {
    // TODO: impl
    (container as GPURayTracingAccelerationContainer_top_Impl).hostBuild(this);
  }
}
