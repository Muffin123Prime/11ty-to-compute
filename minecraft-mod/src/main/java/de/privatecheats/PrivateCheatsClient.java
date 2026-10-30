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
import net.minecraft.world.phys.Vec3;
import org.lwjgl.sdl.SDLScancode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

public class PrivateCheatsClient implements ClientModInitializer {
	public static final String MOD_ID = "privatecheats";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	public static Config config = new Config();

	private static KeyMapping menuKey;
	private static KeyMapping xrayKey;
	private static KeyMapping fullbrightKey;
	private static KeyMapping flyKey;
	private static KeyMapping espKey;
	private static KeyMapping speedKey;
	private static KeyMapping gamemodeKey;

	/** Merkt sich, ob wir die Flug-Fähigkeit selbst gesetzt haben, um sie sauber zurückzusetzen. */
	private boolean flyApplied = false;

	@Override
	public void onInitializeClient() {
		config = Config.load();
		Cheats.rebuildXrayBlocks(config);

		KeyMapping.Category category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath(MOD_ID, "main"));

		menuKey = key("menu", SDLScancode.SDL_SCANCODE_L, category);
		xrayKey = key("xray", SDLScancode.SDL_SCANCODE_X, category);
		fullbrightKey = key("fullbright", SDLScancode.SDL_SCANCODE_N, category);
		flyKey = key("fly", SDLScancode.SDL_SCANCODE_K, category);
		espKey = key("esp", SDLScancode.SDL_SCANCODE_V, category);
		speedKey = key("speed", SDLScancode.SDL_SCANCODE_B, category);
		gamemodeKey = key("gamemode", SDLScancode.SDL_SCANCODE_G, category);

		ClientTickEvents.END_CLIENT_TICK.register(this::onTick);

		HudElementRegistry.addLast(Identifier.fromNamespaceAndPath(MOD_ID, "overlay"), (graphics, deltaTracker) -> {
			if (Minecraft.getInstance().player == null) {
				return;
			}

			graphics.text(Minecraft.getInstance().font, "§bPrivateCheats §7[L = Menü]", 4, 4, CommonColors.WHITE);
			List<String> active = activeFeatures();

			if (!active.isEmpty()) {
				graphics.text(Minecraft.getInstance().font, "§a" + String.join(" §7| §a", active), 4, 14, CommonColors.WHITE);
			}
		});

		LOGGER.info("PrivateCheats geladen. L = Menü, X = X-Ray, N = Fullbright, K = Fly, V = ESP, B = Speed, G = Gamemode");
	}

	private static KeyMapping key(String name, int scancode, KeyMapping.Category category) {
		return KeyMappingHelper.registerKeyMapping(new KeyMapping("key.privatecheats." + name, InputConstants.Type.KEYBOARD, scancode, category));
	}

	private void onTick(Minecraft client) {
		LocalPlayer player = client.player;

		if (player == null) {
			return;
		}

		while (menuKey.consumeClick()) {
			client.gui.setScreen(new CheatScreen());
		}

		while (xrayKey.consumeClick()) {
			toggleXray();
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

		while (speedKey.consumeClick()) {
			Cheats.speed = !Cheats.speed;
			say(client, "Speed", Cheats.speed);
		}

		while (gamemodeKey.consumeClick()) {
			String mode = player.isCreative() ? "survival" : "creative";
			ServerCommands.gamemode(mode);
			chat(client, "Sende /gamemode " + mode + " (funktioniert nur mit OP-Rechten auf dem Server)");
		}

		tickFullbright(player);
		tickFly(player);
		tickSpeed(player);
		tickAutoSprint(player);
	}

	/** Schaltet X-Ray um und baut die Chunks neu auf. Wird auch vom Menü benutzt. */
	public static void toggleXray() {
		Minecraft client = Minecraft.getInstance();
		Cheats.xray = !Cheats.xray;

		if (Cheats.xray) {
			config = Config.load();
			Cheats.rebuildXrayBlocks(config);

			if (config.xrayEnablesFullbright) {
				Cheats.fullbright = true;
			}
		}

		if (client.level != null) {
			client.levelExtractor.allChanged();
		}
	}

	private void tickFullbright(LocalPlayer player) {
		if (Cheats.fullbright) {
			if (!player.hasEffect(MobEffects.NIGHT_VISION)) {
				player.addEffect(new MobEffectInstance(MobEffects.NIGHT_VISION, 1_000_000, 0, false, false, false));
			}
		} else if (player.hasEffect(MobEffects.NIGHT_VISION)) {
			MobEffectInstance effect = player.getEffect(MobEffects.NIGHT_VISION);

			// Nur unseren eigenen (sehr langen, unsichtbaren) Effekt entfernen, keinen echten vom Server.
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

	private void tickSpeed(LocalPlayer player) {
		if (!Cheats.speed || !player.onGround() || player.getAbilities().flying) {
			return;
		}

		boolean moving = player.zza != 0.0f || player.xxa != 0.0f;

		if (!moving) {
			return;
		}

		Vec3 motion = player.getDeltaMovement();
		double factor = config.speedMultiplier;
		player.setDeltaMovement(motion.x * factor, motion.y, motion.z * factor);
	}

	private void tickAutoSprint(LocalPlayer player) {
		if (Cheats.autoSprint && player.zza > 0.0f && !player.isShiftKeyDown() && !player.isSprinting()) {
			player.setSprinting(true);
		}
	}

	private static List<String> activeFeatures() {
		List<String> list = new ArrayList<>(6);
		if (Cheats.xray) list.add("X-Ray");
		if (Cheats.fullbright) list.add("Fullbright");
		if (Cheats.fly) list.add("Fly");
		if (Cheats.esp) list.add("ESP");
		if (Cheats.speed) list.add("Speed");
		if (Cheats.autoSprint) list.add("AutoSprint");
		return list;
	}

	private static void say(Minecraft client, String feature, boolean on) {
		chat(client, feature + ": " + (on ? "§aAN" : "§cAUS"));
	}

	public static void chat(Minecraft client, String message) {
		client.gui.hud.getChat().addClientSystemMessage(Component.literal("§7[§bPrivateCheats§7] §f" + message));
	}
}
