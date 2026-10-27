// Scroll position of the story, shared by the scroll engine (writes) and the 3D stage (reads every frame).
// t = scene index + progress through it: 0 is the first scene's start, 8.99 the last scene's end.
export const story = { t: 0 };
