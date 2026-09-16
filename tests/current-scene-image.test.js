import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtInRoot = path.join(repositoryRoot, 'public/scripts/extensions/stable-diffusion');
const extensionRoot = path.join(repositoryRoot, 'public/scripts/extensions/third-party/current-scene-image');
const source = fs.readFileSync(path.join(extensionRoot, 'index.js'), 'utf8');
const settings = fs.readFileSync(path.join(extensionRoot, 'settings.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const builtInSource = fs.readFileSync(path.join(builtInRoot, 'index.js'), 'utf8');
const builtInSettings = fs.readFileSync(path.join(builtInRoot, 'settings.html'), 'utf8');
const builtInDropdown = fs.readFileSync(path.join(builtInRoot, 'dropdown.html'), 'utf8');

describe('model-agnostic current-scene image flow', () => {
    test('lives in an independent third-party extension', () => {
        expect(manifest.display_name).toBe('Current Scene Image');
        expect(manifest.loading_order).toBeGreaterThan(10);
        expect(source).toContain("const EXTENSION_ID = 'third-party/current-scene-image';");
        expect(builtInSource).not.toContain('KREA_SCENE');
        expect(builtInSettings).not.toContain('sd_krea_prompt_profile');
        expect(builtInDropdown).not.toContain('sd_krea_scene');
    });

    test('the message paintbrush always starts from editable message text', () => {
        expect(settings).toContain('id="ksi_takeover_message_button"');
        expect(source).toContain("event.target.closest('.sd_message_gen')");
        expect(source).toContain("'截取要转换成图片的场景'");
        expect(source).toContain("String(message?.mes || '').trim()");
        expect(source).toContain('const generatedPrompt = await generateImagePrompt(sceneText, controller.signal);');
    });

    test('uses an isolated prompt profile and sends the approved prompt through native image generation', () => {
        expect(settings).toContain('id="ksi_prompt_profile"');
        expect(source).toContain('const profileId = resolveProfileId();');
        expect(source).toContain('ConnectionManagerRequestService.sendRequest(');
        expect(source).toContain('{ extractData: true, includePreset: false, stream: false, signal },');
        expect(source).not.toContain("thinking: { type: 'disabled' }");
        expect(source).toContain('const approvedPrompt = await reviewPrompt(generatedPrompt);');
        expect(source).toContain('const command = SlashCommandParser.commands.imagine;');
        expect(source).toMatch(/command\.callback\(\{[\s\S]*?quiet: 'true',[\s\S]*?extend: 'false',[\s\S]*?\}, prompt\)/);
        expect(source).toContain('await attachImage(messageId, approvedPrompt, url);');
    });
});
