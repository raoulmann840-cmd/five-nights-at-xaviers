# Classroom — background overrides (advanced, optional)

The game pre-renders every view in 3D at load time. If you render your own scenes
(Blender, Cinema 4D…) you can replace them. Use **16:9** images; they are scaled to
each player's screen automatically.

| File | View |
|---|---|
| `center.png` | Facing front: supply locker between the chalkboards, doors at both sides |
| `door_left.png` | At the classroom door, looking down the hallway (door open) |
| `door_right.png` | At the storage-closet door, looking in (door open) |
| `locker.png` | Close-up of the supply locker, doors removed/open |
| `desks.png` | Turned around: desk cluster & teacher's podium |
| `door_left_closed.png`, `door_right_closed.png`, `locker_closed.png` | The door/locker held shut (full frame) |

Optional per view, to make the flashlight light your render correctly:
- `<view>_normal.png`: view-space normal map (RGB = XYZ, like Blender's Normal pass in camera space).
- `<view>_depth.png`: depth map, **white = near (0.8 m), black = far (14 m)**.

Without them, a normal map is estimated from brightness and depth defaults to 4 m.
