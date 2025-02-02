import React, { useState } from 'react'
import { StoreContext } from './store'
import { get } from 'lodash'
import LabelValue from './label_value'

interface LabelValueWrapperProps {
    label: string
    path: string
    prefix?: string
    suffix?: string
    required?: boolean
    parent?: any
}

/**
 * `LabelValueWrapper` is a React functional component that renders a label-value pair,
 * where the value is retrieved from a context (`StoreContext`) or an optional parent object based on the provided `path`.
 * The component conditionally renders the label-value pair based on the `required` prop.
 *
 * @param {LabelValueWrapperProps} props - The props for the `LabelValueWrapper` component.
 * @param {string} props.label - The label to display next to the value.
 * @param {string} props.path - The path in the data where the value can be found.
 * @param {boolean} [props.required=false] - A flag to determine if the label-value pair should be rendered.
 * @param {any} [props.parent=null] - Optional. A custom parent object to retrieve the data from, instead of the global store context.
 *
 * @returns {JSX.Element | null} - A JSX element containing the label and value if `required` is true, or null if `required` is false.
 *
 * @example
 * // Renders the label and value from the store context if `required` is true.
 * <LabelValueWrapper label="Username" path="user.username" required={true} />
 *
 * @example
 * // Renders the label and value from a custom parent object if `parent` is provided.
 * <LabelValueWrapper label="Email" path="user.email" required={true} parent={parentDoc} />
 */
const LabelValueWrapper: React.FC<LabelValueWrapperProps> = ({
    label,
    path,
    prefix,
    suffix,
    parent = null,
    required = false,
}: LabelValueWrapperProps): JSX.Element | null => {
    const [parentData, _] = useState<any>(parent?.data_)
    return (
        <StoreContext.Consumer>
            {({ data }) => {
                const data_object = parent ? parentData : data
                const key = path == null ? '' : path
                const value = get(data_object, key)
                return (
                    <LabelValue
                        label={label}
                        value={value}
                        required={required}
                        prefix={prefix}
                        suffix={suffix}
                    />
                )
            }}
        </StoreContext.Consumer>
    )
}

export default LabelValueWrapper
