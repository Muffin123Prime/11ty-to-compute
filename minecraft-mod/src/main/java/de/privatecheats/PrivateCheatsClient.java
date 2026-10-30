package de.privatecheats;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.util.CommonColors;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.player.Abilities;
import org.lwjgl.sdl.SDLScancode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

public class PrivateCheatsClient implements ClientModInitializer {
	public static final String MOD_ID = "privatecheats";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	public static Config config = new Config();

	private static KeyMapping xrayKey;
	private static KeyMapping fullbrightKey;
	private static KeyMapping flyKey;
	private static KeyMapping espKey;
	private static KeyMapping gamemodeKey;

	/** Merkt sich, ob wir die Flug-Fähigkeit selbst gesetzt haben, um sie sauber zurückzusetzen. */
	private boolean flyApplied = false;

	@Override
	public void onInitializeClient() {
		config = Config.load();
		Cheats.rebuildXrayBlocks(config);

		KeyMapping.Category category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath(MOD_ID, "main"));

		xrayKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.privatecheats.xray", InputConstants.Type.KEYBOARD, SDLScancode.SDL_SCANCODE_X, category));
		fullbrightKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.privatecheats.fullbright", InputConstants.Type.KEYBOARD, SDLScancode.SDL_SCANCODE_N, category));
		flyKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.privatecheats.fly", InputConstants.Type.KEYBOARD, SDLScancode.SDL_SCANCODE_K, category));
		espKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.privatecheats.esp", InputConstants.Type.KEYBOARD, SDLScancode.SDL_SCANCODE_V, category));
		gamemodeKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.privatecheats.gamemode", InputConstants.Type.KEYBOARD, SDLScancode.SDL_SCANCODE_G, category));

		ClientTickEvents.END_CLIENT_TICK.register(this::onTick);

		HudElementRegistry.addLast(Identifier.fromNamespaceAndPath(MOD_ID, "overlay"), (graphics, deltaTracker) -> {
			List<String> active = activeFeatures();

			if (active.isEmpty()) {
				return;
			}

			graphics.text(Minecraft.getInstance().font, "PrivateCheats: " + String.join(" | ", active), 4, 4, CommonColors.WHITE);
		});

		LOGGER.info("PrivateCheats geladen. Tasten: X = X-Ray, N = Fullbright, K = Fly, V = ESP, G = Gamemode");
	}

	private void onTick(Minecraft client) {
		LocalPlayer player = client.player;

		if (player == null) {
			return;
		}

		while (xrayKey.consumeClick()) {
			Cheats.xray = !Cheats.xray;

			if (Cheats.xray) {
				config = Config.load();
				Cheats.rebuildXrayBlocks(config);

				if (config.xrayEnablesFullbright) {
					Cheats.fullbright = true;
				}
			}

			reloadChunks(client);
			say(client, "X-Ray", Cheats.xray);
		}

		while (fullbrightKey.consumeClick()) {
			Cheats.fullbright = !Cheats.fullbright;
			say(client, "Fullbright", Cheats.fullbright);
		}

		while (flyKey.consumeClick()) {
			Cheats.fly = !Cheats.fly;
			say(client, "Fly", Cheats.fly);
		}

		while (espKey.consumeClick()) {
			Cheats.esp = !Cheats.esp;
			say(client, "ESP", Cheats.esp);
		}

		while (gamemodeKey.consumeClick()) {
			String mode = player.isCreative() ? "survival" : "creative";
			player.connection.sendCommand("gamemode " + mode);
			chat(client, "Sende /gamemode " + mode + " (funktioniert nur mit OP-Rechten auf dem Server)");
		}

		tickFullbright(player);
		tickFly(player);
	}

	private void tickFullbright(LocalPlayer player) {
		if (Cheats.fullbright) {
			if (!player.hasEffect(MobEffects.NIGHT_VISION)) {
				player.addEffect(new MobEffectInstance(MobEffects.NIGHT_VISION, 1_000_000, 0, false, false, false));
			}
		} else if (player.hasEffect(MobEffects.NIGHT_VISION)) {
			MobEffectInstance effect = player.getEffect(MobEffects.NIGHT_VISION);

			// Nur unser eigenes (sehr langes, unsichtbares) Effekt entfernen, kein echtes vom Server.
			if (effect != null && effect.getDuration() > 100_000) {
				player.removeEffect(MobEffects.NIGHT_VISION);
			}
		}
	}

	private void tickFly(LocalPlayer player) {
		Abilities abilities = player.getAbilities();

		if (Cheats.fly) {
			abilities.mayfly = true;
			abilities.setFlyingSpeed(config.flySpeed);
			flyApplied = true;
		} else if (flyApplied) {
			flyApplied = false;

			if (!player.isCreative() && !player.isSpectator()) {
				abilities.mayfly = false;
				abilities.flying = false;
			}

			abilities.setFlyingSpeed(0.05f);
		}
	}

	private static void reloadChunks(Minecraft client) {
		if (client.level != null) {
			client.levelExtractor.allChanged();
		}
	}

	private static List<String> activeFeatures() {
		List<String> list = new ArrayList<>(4);
		if (Cheats.xray) list.add("X-Ray");
		if (Cheats.fullbright) list.add("Fullbright");
		if (Cheats.fly) list.add("Fly");
		if (Cheats.esp) list.add("ESP");
		return list;
	}

	private static void say(Minecraft client, String feature, boolean on) {
		chat(client, feature + ": " + (on ? "§aAN" : "§cAUS"));
	}

	private static void chat(Minecraft client, String message) {
		client.gui.hud.getChat().addClientSystemMessage(Component.literal("§7[§bPrivateCheats§7] §f" + message));
	}
}
