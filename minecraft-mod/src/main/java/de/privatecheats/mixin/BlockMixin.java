package de.privatecheats.mixin;

import de.privatecheats.Cheats;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * X-Ray: Seiten von sichtbaren Blöcken auch dann rendern, wenn ein (jetzt unsichtbarer) Nachbar sie verdeckt.
 */
@Mixin(Block.class)
public class BlockMixin {
	@Inject(method = "shouldRenderFace", at = @At("HEAD"), cancellable = true)
	private static void privatecheats$xrayFaces(BlockState state, BlockState neighborState, Direction direction, CallbackInfoReturnable<Boolean> cir) {
		if (Cheats.xray && Cheats.isXrayBlock(state.getBlock())) {
			cir.setReturnValue(true);
		}
	}
}
