#!/usr/bin/env python3
"""Generate the checked-in Xcode project without third-party dependencies."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
objects = {}


def add(identifier, **fields):
    key = hashlib.sha256(identifier.encode()).hexdigest()[:24].upper()
    objects[key] = fields
    return key


def reference(path, kind):
    return add(path, isa="PBXFileReference", lastKnownFileType=kind, path=path, sourceTree="<group>")


sources = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "WorkStep").rglob("*.swift"))
resources = ["WorkStep/Resources/bridge.js", "WorkStep/Resources/navigation.js", "WorkStep/Resources/Assets.xcassets"]
refs = {path: reference(path, "sourcecode.swift") for path in sources}
refs.update({path: reference(path, "folder.assetcatalog" if path.endswith("xcassets") else "sourcecode.javascript") for path in resources})
refs["WorkStep/Info.plist"] = reference("WorkStep/Info.plist", "text.plist.xml")
test_path = "WorkStepUITests/WorkStepUITests.swift"
test_ref = reference(test_path, "sourcecode.swift")
product = add("product", isa="PBXFileReference", explicitFileType="wrapper.application", path="WorkStep.app", sourceTree="BUILT_PRODUCTS_DIR")
test_product = add("test-product", isa="PBXFileReference", explicitFileType="wrapper.cfbundle", path="WorkStepUITests.xctest", sourceTree="BUILT_PRODUCTS_DIR")
products = add("products", isa="PBXGroup", children=[product, test_product], name="Products", sourceTree="<group>")
group = add("group", isa="PBXGroup", children=list(refs.values()) + [test_ref, products], sourceTree="<group>")


def phase(name, kind, files):
    builds = [add("build:" + path, isa="PBXBuildFile", fileRef=ref) for path, ref in files]
    return add(name, isa=kind, buildActionMask="2147483647", files=builds, runOnlyForDeploymentPostprocessing="0")


source_phase = phase("sources", "PBXSourcesBuildPhase", [(path, refs[path]) for path in sources])
resource_phase = phase("resources", "PBXResourcesBuildPhase", [(path, refs[path]) for path in resources])
framework_phase = phase("frameworks", "PBXFrameworksBuildPhase", [])
test_phase = phase("test-sources", "PBXSourcesBuildPhase", [(test_path, test_ref)])


def configurations(name, settings):
    configs = []
    for mode in ["Debug", "Release"]:
        flags = dict(settings)
        flags.update(SWIFT_OPTIMIZATION_LEVEL="-Onone" if mode == "Debug" else "-O", DEBUG_INFORMATION_FORMAT="dwarf" if mode == "Debug" else "dwarf-with-dsym")
        if mode == "Debug":
            flags.update(ENABLE_TESTABILITY="YES", SWIFT_ACTIVE_COMPILATION_CONDITIONS="DEBUG")
        configs.append(add(name + mode, isa="XCBuildConfiguration", buildSettings=flags, name=mode))
    return add(name + "configs", isa="XCConfigurationList", buildConfigurations=configs, defaultConfigurationIsVisible="0", defaultConfigurationName="Release")


project_configs = configurations("project", {
    "IPHONEOS_DEPLOYMENT_TARGET": "16.0", "SDKROOT": "iphoneos", "SWIFT_VERSION": "5.0",
    "CLANG_ENABLE_MODULES": "YES", "CLANG_ENABLE_OBJC_ARC": "YES", "SWIFT_STRICT_CONCURRENCY": "targeted",
})
app_configs = configurations("app", {
    "PRODUCT_BUNDLE_IDENTIFIER": "com.workstep.ios", "PRODUCT_NAME": "$(TARGET_NAME)",
    "INFOPLIST_FILE": "WorkStep/Info.plist", "GENERATE_INFOPLIST_FILE": "NO", "CODE_SIGN_STYLE": "Automatic",
    "TARGETED_DEVICE_FAMILY": "1,2", "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator", "SUPPORTS_MACCATALYST": "NO",
    "MARKETING_VERSION": "0.1.0", "CURRENT_PROJECT_VERSION": "1", "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
    "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"],
})
app = add("app-target", isa="PBXNativeTarget", buildConfigurationList=app_configs,
          buildPhases=[source_phase, framework_phase, resource_phase], buildRules=[], dependencies=[], name="WorkStep",
          productName="WorkStep", productReference=product, productType="com.apple.product-type.application")
test_configs = configurations("ui-test", {
    "PRODUCT_BUNDLE_IDENTIFIER": "com.workstep.ios.uitests", "PRODUCT_NAME": "$(TARGET_NAME)",
    "GENERATE_INFOPLIST_FILE": "YES", "CODE_SIGN_STYLE": "Automatic", "TARGETED_DEVICE_FAMILY": "1,2",
    "TEST_TARGET_NAME": "WorkStep", "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks"],
})
project_id = hashlib.sha256(b"project").hexdigest()[:24].upper()
proxy = add("proxy", isa="PBXContainerItemProxy", containerPortal=project_id, proxyType="1", remoteGlobalIDString=app, remoteInfo="WorkStep")
dependency = add("dependency", isa="PBXTargetDependency", target=app, targetProxy=proxy)
tests = add("test-target", isa="PBXNativeTarget", buildConfigurationList=test_configs, buildPhases=[test_phase], buildRules=[],
            dependencies=[dependency], name="WorkStepUITests", productName="WorkStepUITests", productReference=test_product,
            productType="com.apple.product-type.bundle.ui-testing")
project = add("project", isa="PBXProject", attributes={"LastUpgradeCheck": "1600", "TargetAttributes": {app: {"CreatedOnToolsVersion": "16.0"}, tests: {"CreatedOnToolsVersion": "16.0", "TestTargetID": app}}},
              buildConfigurationList=project_configs, compatibilityVersion="Xcode 14.0", developmentRegion="zh_CN",
              hasScannedForEncodings="0", knownRegions=["zh_CN", "en", "Base"], mainGroup=group, productRefGroup=products,
              projectDirPath="", projectRoot="", targets=[app, tests])


def encode(value, indent=0):
    if isinstance(value, dict):
        return "{\n" + "".join("\t" * (indent + 1) + json.dumps(k) + " = " + encode(v, indent + 1) + ";\n" for k, v in value.items()) + "\t" * indent + "}"
    if isinstance(value, list):
        return "(" + ", ".join(encode(item, indent) for item in value) + ")"
    return json.dumps(value, ensure_ascii=False)


directory = ROOT / "WorkStep.xcodeproj"
directory.mkdir(exist_ok=True)
(directory / "project.pbxproj").write_text("// !$*UTF8*$!\n" + encode({"archiveVersion": "1", "classes": {}, "objectVersion": "56", "objects": objects, "rootObject": project}) + "\n")
scheme_dir = directory / "xcshareddata/xcschemes"
scheme_dir.mkdir(parents=True, exist_ok=True)


def buildable(identifier, name, product_name):
    return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{identifier}" BuildableName="{product_name}" BlueprintName="{name}" ReferencedContainer="container:WorkStep.xcodeproj"/>'


app_ref = buildable(app, "WorkStep", "WorkStep.app")
test_ref_xml = buildable(tests, "WorkStepUITests", "WorkStepUITests.xctest")
(scheme_dir / "WorkStep.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app_ref}</BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{test_ref_xml}</TestableReference></Testables></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
print(f"Generated WorkStep.xcodeproj: {len(sources)} Swift sources")
