export function prefillFormHardcodedProject(
    handleFormSelect: (form: {
        id: string
        form_data: any
        user_id: string
        process_step_id: string
        created_at: string
        updated_at: string | null
    }) => void,
): string {
    const project = {
        address: {
            city: 'Shelby',
            full_address: '2001 East Dixon Boulevard',
            state: 'NC',
            street: 'East Dixon Boulevard',
            street_number: '2001',
            zip_code: '28152',
        },
        applicant: {
            email: 'maxine@everblue.com',
            first_name: 'maxine',
            id: 'f46c6d3f-658b-45d8-b146-d2fa985233c7',
            last_name: 'meurer',
            phone: '9999999999',
        },
        program: {
            code: 'HEAR',
            name: 'Home Energy Assistance Rebate Program',
        },
        review_tasks: [
            {
                id: '6a92a670-f953-47e2-8ac5-545746b3d244',
                type: { code: 'INCOME_REVIEW' },
            },
        ],
    }

    const formData = {
        selectedProgram: project.program.code,
        address: project.address,
        user: project.applicant,
        process_name: project.program.name,
        process_id: '0f9762cc-4b70-45e8-8733-378859078dea', // fake need to change
        project_status: 'PREFILLED_FROM_PARENT',
    }

    const formId = crypto.randomUUID()
    const processStepId = project.review_tasks[0].id
    const userId = project.applicant.id

    window.docData = formData
    window.docDataMap = window.docDataMap || {}
    window.docDataMap[formId] = formData
    localStorage.setItem('form_id', formId)

    handleFormSelect({
        id: formId,
        form_data: formData,
        user_id: userId,
        process_step_id: processStepId,
        created_at: new Date().toISOString(),
        updated_at: null,
    })

    console.log(
        '[Prefill Debug] Form successfully injected with project:',
        formData,
    )
    return formId
}
