package de.privatecheats.mixin;

import de.privatecheats.Cheats;
import de.privatecheats.PrivateCheatsClient;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * ESP: Spieler (und optional alle Lebewesen) bekommen clientseitig den Leucht-Effekt und sind so durch Wände sichtbar.
 */
@Mixin(Entity.class)
public class EntityMixin {
	@Inject(method = "isCurrentlyGlowing", at = @At("HEAD"), cancellable = true)
	private void privatecheats$espGlow(CallbackInfoReturnable<Boolean> cir) {
		if (!Cheats.esp) {
			return;
		}

		Object self = this;

		if (self == Minecraft.getInstance().player) {
			return;
		}

		if (self instanceof Player || (!PrivateCheatsClient.config.espPlayersOnly && self instanceof LivingEntity)) {
			cir.setReturnValue(true);
		}
	}
}
