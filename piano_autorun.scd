// Non-interactive startup used by Start-OpenSpace-Piano.bat.
// It evaluates only the main block, leaving the optional IDE snippets below
// it untouched, and starts the bundled score selected below.
(
var patchPath, source, utilityMarker, utilityStart;

~autoStartScore = "FlyMeToTheMoon.score";
patchPath = thisProcess.nowExecutingPath.dirname +/+ "openspace_piano.scd";
source = File.readAllString(patchPath);
utilityMarker = "//  Utilities";
utilityStart = source.find(utilityMarker);

utilityStart.isNil.if {
	Error("Could not find the piano patch's utility marker").throw;
};

thisProcess.interpreter.interpret(source.copyRange(0, utilityStart - 1));
)
