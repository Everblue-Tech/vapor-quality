import DOEWorkflowHeatPumpWaterHeaterTemplate from './doe_workflow_heat_pump_water_heater.mdx'
import DOEWorkflowDuctlessHeatPumpTemplate from './doe_workflow_heat_pump_ductless.mdx'
import DOEWorkflowDuctedHeatPumpTemplate from './doe_workflow_heat_pump_ducted.mdx'
import DOEWorkflowDuctAirSealTemplate from './ira_doe_workflow_duct_air_sealing_and_insulation.mdx'
import DOEWorkflowElectricCookTemplate from './ira_doe_workflow_electric_cooking_appliance.mdx'
import DOEWorkflowElectricWiringTemplate from './ira_doe_workflow_electric_wiring.mdx'
import DOEWorkflowElectricLoadServiceTemplate from './ira_doe_workflow_electric_load_service_center.mdx'
import DOEWorkflowHighEfficiencyGasFurnace from './ira_doe_workflow_high_efficiency_gas_furnace.mdx'
import DOEWorkflowHighEfficiencyWaterHeater from './ira_doe_workflow_high_efficiency_water_heater.mdx'
import DOEWorkflowHighEfficiencyModulatingBoiler from './ira_doe_workflow_high_efficiency_modulating_boiler.mdx'
import DOEWorkflowFullFrameReplacementWindows from './ira_doe_workflow_full_frame_replacement_windows.mdx'
import DOEWorkflowInsertReplacementWindows from './ira_doe_workflow_insert_replacement_windows.mdx'
import DOEWorkflowFloorAirSealingAndInsulation from './ira_doe_workflow_floor_air_sealing_and_insulation.mdx'
import DOEWorkflowFoundationAirSealingAndInsulation from './ira_doe_workflow_foundation_wall_air_sealing_and_insulation.mdx'
import DOEWorkflowHPClothDyer from './ira_doe_workflow_heat_pump_cloth_dryer.mdx'
import DOEWorkflowMechanicalVentilation from './ira_doe_workflow_mechanical_ventilation.mdx'
import DOEWorkflowSlapFoundationExterior from './ira_doe_workflow_slap_foundation_exterior_sealing_and_insulation.mdx'
import DOEWorkflowWallAirSealingAndInsulation from './ira_doe_workflow_wall_air_sealing_and_insulation_dry_fill.mdx'
import DOEWorkflowAtticAirSealingAndInsulation from './ira_doe_workflow_attic_air_sealing_and_insulation.mdx'
import IRADOEWorkflowLimitedAssessment from './ira_doe_workflow_limited_assessment.mdx'
import DOECombustionApplianceSafetyTests from './doe_workflow_combustion_appliance_safety_tests.mdx'

import { MDXProps } from 'mdx/types'

interface TemplatesConfig {
    [key: string]: {
        title: string
        template: (props: MDXProps) => JSX.Element
    }
}

const templateRegex = /^(?!_)(?!.*_$)[a-z0-9_]{1,64}$/

// Add workflow templates for 'quality-install-tool'
const templatesConfig: TemplatesConfig = {
    doe_workflow_attic_air_sealing_and_insulation: {
        title: 'Attic Air Sealing and Insulation',
        template: DOEWorkflowAtticAirSealingAndInsulation,
    },
    doe_combustion_appliance_safety_tests: {
        title: 'Combustion Appliance Safety Testing',
        template: DOECombustionApplianceSafetyTests,
    },
    doe_workflow_duct_air_sealing: {
        title: 'Duct Air Sealing and Insulation',
        template: DOEWorkflowDuctAirSealTemplate,
    },
    doe_workflow_electric_cooking_appliances: {
        title: 'Electric Cooking Appliances',
        template: DOEWorkflowElectricCookTemplate,
    },
    doe_workflow_electric_wiring: {
        title: 'Electric Wiring',
        template: DOEWorkflowElectricWiringTemplate,
    },
    doe_workflow_electric_load_service_center: {
        title: 'Electric Load Service Center',
        template: DOEWorkflowElectricLoadServiceTemplate,
    },
    doe_workflow_floor_airsealing_and_insulation: {
        title: 'Floor Air Sealing and Insulation Above Unconditioned Space',
        template: DOEWorkflowFloorAirSealingAndInsulation,
    },
    doe_workflow_foundation_airsealing_and_insulation: {
        title: 'Foundation Wall Air Sealing and Insulation',
        template: DOEWorkflowFoundationAirSealingAndInsulation,
    },
    doe_workflow_full_frame_replacement_windows: {
        title: 'Full Frame Replacement Windows',
        template: DOEWorkflowFullFrameReplacementWindows,
    },
    doe_workflow_heat_pump_cloth_dryer: {
        title: 'Heat Pump Clothes Dryer',
        template: DOEWorkflowHPClothDyer,
    },
    doe_workflow_central_ducted_split_heat_pump: {
        title: 'Heat Pump Ducted',
        template: DOEWorkflowDuctedHeatPumpTemplate,
    },
    doe_workflow_ductless_heat_pump: {
        title: 'Heat Pump Ductless',
        template: DOEWorkflowDuctlessHeatPumpTemplate,
    },
    doe_workflow_heat_pump_water_heater: {
        title: 'Heat Pump Water Heater',
        template: DOEWorkflowHeatPumpWaterHeaterTemplate,
    },
    doe_workflow_high_efficiency_gas_furnace: {
        title: 'High Efficiency Gas Furnace',
        template: DOEWorkflowHighEfficiencyGasFurnace,
    },
    doe_workflow_high_efficiency_modulating_boiler: {
        title: 'High Efficiency Modulating Boiler',
        template: DOEWorkflowHighEfficiencyModulatingBoiler,
    },
    doe_workflow_high_efficiency_water_heater: {
        title: 'High Efficiency Water Heater',
        template: DOEWorkflowHighEfficiencyWaterHeater,
    },
    doe_workflow_insert_replacement_windows: {
        title: 'Insert Replacement Windows',
        template: DOEWorkflowInsertReplacementWindows,
    },
    doe_workflow_mechanical_ventilation: {
        title: 'Mechanical Ventilation',
        template: DOEWorkflowMechanicalVentilation,
    },
    doe_workflow_slab_foundation_exterior: {
        title: 'Slab Foundation Exterior Perimeter Sealing and Insulation',
        template: DOEWorkflowSlapFoundationExterior,
    },
    doe_workflow_wall_air_sealing_and_insulation_exterior: {
        title: 'Wall Air Sealing and Insulation (Drill and Fill)',
        template: DOEWorkflowWallAirSealingAndInsulation,
    },
    ira_doe_workflow_limited_assessment: {
        title: 'IRA Limited Assessment',
        template: IRADOEWorkflowLimitedAssessment,
    },
}

// Measure Type to Template Mapping
export const measureTypeMapping: Record<string, string[]> = {
    AIR_SEALING: ['Attic Air Sealing and Insulation'],
    APPLIANCE: ['High Efficiency Water Heater', 'High Efficiency Gas Furnace'],
    CEILING_INSULATION: ['Attic Air Sealing and Insulation'],
    COOLING_EQUIPMENT: ['Heat Pump Ducted', 'Heat Pump Ductless'],
    DUCT_INSULATION: ['Duct Air Sealing and Insulation'],
    DUCT_SEALING: ['Duct Air Sealing and Insulation'],
    FLOOR_INSULATION: [
        'Floor Air Sealing and Insulation Above Unconditioned Space',
    ],
    FOUNDATION_INSULATION: ['Foundation Wall Air Sealing and Insulation'],
    HEATING_EQUIPMENT: [
        'Heat Pump Ducted',
        'Heat Pump Ductless',
        'High Efficiency Gas Furnace',
    ],
    VENTILATION: ['Mechanical Ventilation'],
    WALL_INSULATION: ['Wall Air Sealing and Insulation (Drill and Fill)'],
    WATER_HEATER: ['Heat Pump Water Heater', 'High Efficiency Water Heater'],
    WINDOW_ATTACHMENT: ['Insert Replacement Windows'],
    WINDOW_REPLACEMENT: ['Full Frame Replacement Windows'],
    ELECTRICAL_PANEL: ['Electric Load Service Center'],
    ELECTRIC_COOKING_APPLIANCE: ['Electric Cooking Appliances'],
    ELECTRIC_WIRING: ['Electric Wiring'],
    HEAT_PUMP_CLOTHES_DRYER: ['Heat Pump Clothes Dryer'],
    HEAT_PUMP_FOR_SPACE_HEATING_OR_COOLING: [
        'Heat Pump Ducted',
        'Heat Pump Ductless',
    ],
    HEAT_PUMP_WATER_HEATER: ['Heat Pump Water Heater'],
    INSULATION_AIR_SEALING_VENTILATION: [
        'Attic Air Sealing and Insulation',
        'Wall Air Sealing and Insulation (Drill and Fill)',
        'Floor Air Sealing and Insulation Above Unconditioned Space',
        'Foundation Wall Air Sealing and Insulation',
        'Mechanical Ventilation',
    ],
}

export const mapMeasuresToTemplateValues = (inputs: string[]): string[] => {
    const result = new Set<string>()

    for (const input of inputs) {
        const matches = measureTypeMapping[input]
        if (matches) {
            matches.forEach(match => result.add(match))
        } else {
            console.warn('No template mapping found for:', input)
        }
    }
    return Array.from(result)
}

// Build reverse mapping from template title => normalized measure name
export const reverseTemplateMap: Record<string, string> = {}

for (const [measureKey, titles] of Object.entries(measureTypeMapping)) {
    for (const title of titles) {
        reverseTemplateMap[title.trim().toLowerCase()] = measureKey
    }
}

// Assuming TemplatesConfig is defined somewhere as a type or interface

/**
 * Validates a TemplatesConfig object by checking if template names adhere to templateRegex pattern.
 * @param {TemplatesConfig} config - The TemplatesConfig object to validate.
 * @throws {Error} Throws an error if one or more template names are not allowed.
 */
function validateTemplatesConfig(config: TemplatesConfig) {
    Object.keys(config).forEach(key => {
        if (!templateRegex.test(key)) {
            throw new Error(key + ' template name is not allowed') //Decide on what to do if not pass
        }
    })
}

validateTemplatesConfig(templatesConfig)

export default templatesConfig
