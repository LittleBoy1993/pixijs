import { ExtensionType } from '../../../extensions/Extensions';
import { STENCIL_MODES } from '../../renderers/shared/state/const';
import { collectAllRenderables } from '../../scene/utils/buildInstructions';

import type { Instruction } from '../../renderers/shared/instructions/Instruction';
import type { InstructionSet } from '../../renderers/shared/instructions/InstructionSet';
import type { InstructionPipe } from '../../renderers/shared/instructions/RenderPipe';
import type { Renderer } from '../../renderers/types';
import type { Container } from '../../scene/Container';
import type { Effect } from '../../scene/Effect';
import type { StencilMask } from './StencilMask';

type MaskMode = 'pushMaskBegin' | 'pushMaskEnd' | 'popMaskBegin' | 'popMaskEnd';

export interface StencilMaskInstruction extends Instruction
{
    type: 'stencilMask',
    action: MaskMode,
    mask: StencilMask,
}

export class StencilMaskPipe implements InstructionPipe<StencilMaskInstruction>
{
    public static extension = {
        type: [
            ExtensionType.WebGLPipes,
            ExtensionType.WebGPUPipes,
            ExtensionType.CanvasPipes,
        ],
        name: 'stencilMask',
    } as const;

    private _renderer: Renderer;

    // used when building and also when executing..
    private _maskStackHash: Record<number, number> = {};

    private _maskHash = new WeakMap<StencilMask, {
        instructionsStart: number,
        instructionsLength: number,
    }>();

    constructor(renderer: Renderer)
    {
        this._renderer = renderer;
    }

    public push(mask: Effect, _container: Container, instructionSet: InstructionSet): void
    {
        const renderer = this._renderer;

        renderer.renderPipes.batch.break(instructionSet);
        renderer.renderPipes.blendMode.setBlendMode(mask.mask, 'none', instructionSet);

        instructionSet.add({
            type: 'stencilMask',
            action: 'pushMaskBegin',
            mask,
            canBundle: false,
        } as StencilMaskInstruction);

        const effect = mask as StencilMask;
        const maskContainer = effect.mask;

        maskContainer.includeInBuild = true;

        if (!this._maskHash.has(effect))
        {
            this._maskHash.set(effect, {
                instructionsStart: 0,
                instructionsLength: 0,
            });
        }

        const maskData = this._maskHash.get(effect);

        maskData.instructionsStart = instructionSet.instructionSize;

        collectAllRenderables(
            maskContainer,
            instructionSet,
            renderer.renderPipes,
        );

        maskContainer.includeInBuild = false;

        renderer.renderPipes.batch.break(instructionSet);

        instructionSet.add({
            type: 'stencilMask',
            action: 'pushMaskEnd',
            mask,
            canBundle: false,
        } as StencilMaskInstruction);

        const instructionsLength = instructionSet.instructionSize - maskData.instructionsStart - 1;

        maskData.instructionsLength = instructionsLength;

        if (this._maskStackHash[_container.uid] === undefined)
        {
            this._maskStackHash[_container.uid] = 0;
        }

        this._maskStackHash[_container.uid]++;
    }

    public pop(mask: Effect, _container: Container, instructionSet: InstructionSet): void
    {
        const renderer = this._renderer;

        // stencil is stored based on current render target..

        this._maskStackHash[_container.uid]--;

        renderer.renderPipes.batch.break(instructionSet);
        renderer.renderPipes.blendMode.setBlendMode(mask.mask, 'none', instructionSet);

        instructionSet.add({
            type: 'stencilMask',
            action: 'popMaskBegin',
            canBundle: false,
        });

        const maskData = this._maskHash.get(mask as StencilMask);

        if (this._maskStackHash[_container.uid])
        {
            for (let i = 0; i < maskData.instructionsLength; i++)
            {
                // eslint-disable-next-line max-len
                instructionSet.instructions[instructionSet.instructionSize++] = instructionSet.instructions[maskData.instructionsStart++];
            }
        }

        instructionSet.add({
            type: 'stencilMask',
            action: 'popMaskEnd',
            canBundle: false,
        });
    }

    public execute(instruction: StencilMaskInstruction)
    {
        const renderer = this._renderer;
        const currentRenderTargetUid = renderer.renderTarget.renderTarget.uid;

        let maskStackIndex = this._maskStackHash[currentRenderTargetUid] ?? 0;

        if (instruction.action === 'pushMaskBegin')
        {
            maskStackIndex++;
            renderer.stencil.setStencilMode(STENCIL_MODES.RENDERING_MASK_ADD, maskStackIndex);
            renderer.colorMask.setMask(0);
        }
        else if (instruction.action === 'pushMaskEnd')
        {
            renderer.stencil.setStencilMode(STENCIL_MODES.MASK_ACTIVE, maskStackIndex);
            renderer.colorMask.setMask(0xF);
        }
        else if (instruction.action === 'popMaskBegin')
        {
            maskStackIndex--;

            if (maskStackIndex !== 0)
            {
                renderer.stencil.setStencilMode(STENCIL_MODES.RENDERING_MASK_REMOVE, maskStackIndex);
                renderer.colorMask.setMask(0);
            }
        }
        else if (instruction.action === 'popMaskEnd')
        {
            if (maskStackIndex === 0)
            {
                renderer.stencil.setStencilMode(STENCIL_MODES.DISABLED, maskStackIndex);
            }
            else
            {
                renderer.stencil.setStencilMode(STENCIL_MODES.MASK_ACTIVE, maskStackIndex);
            }

            renderer.colorMask.setMask(0xF);
        }

        this._maskStackHash[currentRenderTargetUid] = maskStackIndex;
    }

    public destroy()
    {
        this._renderer = null;
        this._maskStackHash = null;
        this._maskHash = null;
    }
}
