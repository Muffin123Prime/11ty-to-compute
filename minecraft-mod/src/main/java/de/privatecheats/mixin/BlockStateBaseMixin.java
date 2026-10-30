package de.privatecheats.mixin;

import de.privatecheats.Cheats;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockBehaviour;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * X-Ray: Alle Blöcke, die nicht in der Liste stehen, werden beim Chunk-Aufbau als unsichtbar gemeldet.
 */
@Mixin(BlockBehaviour.BlockStateBase.class)
public abstract class BlockStateBaseMixin {
	@Shadow
	public abstract Block getBlock();

	@Inject(method = "getRenderShape", at = @At("HEAD"), cancellable = true)
	private void privatecheats$xrayRenderShape(CallbackInfoReturnable<RenderShape> cir) {
		if (Cheats.xray && !Cheats.isXrayBlock(this.getBlock())) {
			cir.setReturnValue(RenderShape.INVISIBLE);
		}
	}
}
