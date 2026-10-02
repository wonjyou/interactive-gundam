# Interactive Gundam

An RX-78-2 you pose from the keyboard or by touch, shown as a crosshatched wireframe (the default), as particles, or with its full materials. It stands still until a key is held.

## Run it

```bash
node serve.js
```

Then open http://localhost:8769. three.js loads from a CDN, so the first load needs a connection.

## Controls

| Key | What it does |
| --- | --- |
| W (hold) | Walk in place |
| Space | Jump, with thruster exhaust and a dust ring on landing |
| C (hold) | Kneel: right knee down, left foot forward, rifle levelled. F fires from the knee |
| F (tap or hold) | Fire the rifle: standing, it plays the model's own leaping-shot animation with a muzzle blast (flash, blast cone, shock rings, beam streak), and hovers and keeps firing while held |
| E | Draw the beam sabre from the backpack, coil back, and lunge through the cut |
| ← → | Spin the view around the model |
| ↑ ↓ | Tilt the view above or below |
| X | See through to the far side (particles and wireframe only) |
| 1 / 2 / 3 | Full materials / Wireframe / Particles |
| V | Switch particles between color and white |

Drag to turn the view; scroll or pinch to zoom. The on-screen keys work by click or touch. They sit in a panel at the bottom, under a row of material switches: the button in the panel's top right corner minimizes it to a single "Controls" button (it eases between the two sizes), and "Credits" at the bottom opens and closes the model credit.

On touch screens the letter hints and arrow keys are hidden, since there is no keyboard and dragging turns the view.

## How it is built

- **Particles from the model.** `main.js` scatters points over the mesh surface (weighted by triangle area) and reads each point's colour from the model's texture. Phones get 70,000 points, larger screens 110,000.
- **Wireframe.** Crease and border edges of the same mesh, coloured from the texture and moved by the same bones. The surface between them is crosshatched: the hatch is fixed to each panel in the rest pose, and faces get one set of diagonals or two depending on how much light they catch. Details that exist only in the model's paint, such as the shield's cross, are outlined wherever the texture's colour changes.
- **Full materials.** The model's own mesh and material, lit.
- **The model's own skeleton.** Each particle and line vertex is tied to one bone and moved in the vertex shader from the skeleton's bone texture. A few particles follow a delayed copy of the pose, which gives fast limbs a short wake.
- **Poses.** Walk, crouch, jump and slash are computed each frame and written onto the bones. Firing blends in the last 1.5 seconds of the clip baked into the file (the spin into an aimed shot).
- **Weapons.** The rifle, shield and sabre sit loose beside the body in the file. They are hung on the mount points the model provides (hands, backpack, waist) and swapped during the slash.
- **Depth.** In the particle and wireframe looks the real mesh is drawn into the depth buffer only, so the far side is hidden. X turns that off.
- **Loose particles.** The beam, sabre blade, thruster exhaust, footstep and landing dust are a separate CPU-simulated pool.
- **Framing.** The camera fits the model into the space left between the title and the controls, and refits when the controls collapse.

## Credit

Model: [RX-78-2 Gundam](https://sketchfab.com/3d-models/rx-78-2-gundam-8b1ec0f948984aa897e60b63a13b501c) by [みそ太郎 (nama_140)](https://sketchfab.com/nama_140) on Sketchfab, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). `gundam.glb` is that model's file, unmodified.
